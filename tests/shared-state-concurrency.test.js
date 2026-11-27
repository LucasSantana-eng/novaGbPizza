const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const begin = html.indexOf('        async function save()');
const end = html.indexOf('        async function persistCashStatusForOnlineOrders()', begin);
assert.ok(begin !== -1 && end !== -1);

function setup(initial) {
    let remote = JSON.parse(JSON.stringify(initial));
    const blocks = [];
    const localWrites = [];
    const context = {
        S: JSON.parse(JSON.stringify(initial)), KEY: 'test',
        sharedStateSaveCount: 0, sharedStateWriteQueue: Promise.resolve(),
        sharedStateUrgentSyncRequested: false,
        sharedStateWriteBlocked: false, sharedStateUpdatedAt: '', lastSharedStateSaveError: '',
        localStorage: { setItem(_key, value) { localWrites.push(JSON.parse(value)); } }, setSupabaseStatus() {}, toast() {},
        console: { error() {} },
        blockSharedStateWrites(error) { context.sharedStateWriteBlocked = true; blocks.push(error.message); },
        supabaseClient: {
            from: () => ({
                upsert: value => ({
                    select: () => ({
                        single: async () => {
                            if (value.data._revision !== remote._revision) return { error: { message: 'Estado alterado por outro dispositivo' } };
                            remote = JSON.parse(JSON.stringify(value.data));
                            remote._revision++;
                            return { data: { data: remote, updated_at: '2026-01-01T00:00:00Z' }, error: null };
                        }
                    })
                })
            })
        }
    };
    vm.runInNewContext(`${html.slice(begin, end)}\nthis.save = save;`, context);
    return { context, blocks, localWrites, getRemote: () => remote, setRemote: state => { remote = state; } };
}

test('gravações locais enfileiradas usam a revisão confirmada anterior', async () => {
    const env = setup({ _revision: 0, orders: [], caixa: { status: 'ABERTO' } });
    env.context.S.orders.push({ id: 1 });
    const first = env.context.save();
    env.context.S.orders.push({ id: 2 });
    const second = env.context.save();
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(env.getRemote()._revision, 2);
    assert.deepEqual(env.getRemote().orders.map(order => order.id), [1, 2]);
    assert.deepEqual(env.localWrites[0].orders.map(order => order.id), [1]);
    assert.deepEqual(env.localWrites[1].orders.map(order => order.id), [1, 2]);
});

test('caixa desatualizado não sobrescreve pedido remoto e bloqueia novas gravações', async () => {
    const env = setup({ _revision: 0, orders: [], caixa: { status: 'ABERTO' } });
    env.setRemote({ _revision: 1, orders: [{ id: 7, type: 'MESA' }], caixa: { status: 'ABERTO' } });
    env.context.S.caixa.status = 'FECHADO';
    assert.equal(await env.context.save(), false);
    assert.equal(env.context.sharedStateWriteBlocked, true);
    assert.equal(env.getRemote().orders[0].id, 7);
    assert.equal(env.getRemote().caixa.status, 'ABERTO');
    assert.equal(env.localWrites.length, 0);
    assert.match(env.blocks[0], /outro dispositivo/);
    assert.equal(await env.context.save(), false);
});

test('aviso durante gravações aguarda todas e consulta o banco sem depender do intervalo', async () => {
    const env = setup({ _revision: 0, orders: [] });
    const originalFrom = env.context.supabaseClient.from;
    let queries = 0;
    env.context.supabaseClient.from = () => ({
        ...originalFrom(),
        select() { return this; },
        eq() { return this; },
        single: async () => { queries++; return { data: { data: env.getRemote() }, error: null }; }
    });
    env.context.sharedStateSyncPending = false;
    env.context.applySharedState = () => true;
    const start = html.indexOf('        function requestUrgentStateSync()');
    const end = html.indexOf('        function blockSharedStateWrites(', start);
    vm.runInNewContext(`${html.slice(start, end)}\nthis.requestUrgentStateSync = requestUrgentStateSync;`, env.context);
    const first = env.context.save();
    const second = env.context.save();
    env.context.requestUrgentStateSync();
    env.context.requestUrgentStateSync();
    assert.equal(queries, 0);
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(queries, 1);
});

test('consulta em andamento é repetida se gravação impedir a aplicação da resposta', async () => {
    const requests = [];
    const context = {
        sharedStateSyncPending: false, sharedStateUrgentSyncRequested: false,
        sharedStateSaveCount: 0, sharedStateWriteBlocked: false,
        supabaseClient: { from: () => ({ select() { return this; }, eq() { return this; },
            single: () => new Promise(resolve => requests.push(resolve)) }) },
        applySharedState: () => !context.sharedStateSaveCount,
        console
    };
    const start = html.indexOf('        function requestUrgentStateSync()');
    const end = html.indexOf('        function blockSharedStateWrites(', start);
    vm.runInNewContext(`${html.slice(start, end)}\nthis.requestUrgentStateSync = requestUrgentStateSync;`, context);
    context.requestUrgentStateSync();
    context.sharedStateSaveCount = 1;
    requests[0]({ data: { data: { _revision: 1 } }, error: null });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.sharedStateUrgentSyncRequested, true);
    assert.equal(requests.length, 1);
    context.sharedStateSaveCount = 0;
    context.requestUrgentStateSync();
    assert.equal(requests.length, 2);
    requests[1]({ data: { data: { _revision: 2 } }, error: null });
});
