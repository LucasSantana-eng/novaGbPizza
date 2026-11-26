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
