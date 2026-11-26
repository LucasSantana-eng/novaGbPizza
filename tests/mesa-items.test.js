const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('        async function removerItemMesa(');
const end = html.indexOf('        function adicionarItensMesa(', start);
assert.ok(start !== -1 && end !== -1);

function setup(orders, options = {}) {
    const messages = [];
    let saves = 0;
    let renders = 0;
    const context = {
        S: { orders },
        selectedMesa: 2,
        mesaItemUpdatePending: false,
        currentUser: { name: 'Garçom' },
        supabaseClient: options.online ? {} : null,
        qzSettings: { options: { printCancellation: false } },
        isOrderOpen: order => !order.paid && order.status !== 'CANCELADO',
        confirm: () => options.confirm !== false,
        syncSharedState: options.sync || (async () => true),
        renderAll(persist) { assert.equal(persist, false); renders++; },
        save: async () => { saves++; return options.saved !== false; },
        toast: message => messages.push(message),
        printThermal() { throw new Error('Unexpected print'); }
    };
    vm.runInNewContext(`${html.slice(start, end)}\nthis.remove = removerItemMesa;`, context);
    return { context, messages, saves: () => saves, renders: () => renders };
}

function order(overrides = {}) {
    return {
        id: 1, type: 'MESA', mesa: 2, status: 'PENDENTE', paid: false,
        items: [{ name: 'Pizza', qty: 2, price: 20 }, { name: 'Suco', qty: 1, price: 10 }],
        sub: 50, svc: 5, svcPct: 10, taxa: 0, total: 55,
        ...overrides
    };
}

test('reducing quantity and removing a line recalculate the bill without changing other orders', async () => {
    const first = order();
    const other = order({ id: 2, total: 55 });
    const env = setup([first, other]);
    await env.context.remove(1, 0, false);
    assert.equal(first.items[0].qty, 1);
    assert.equal(first.sub, 30);
    assert.equal(first.svc, 3);
    assert.equal(first.total, 33);
    await env.context.remove(1, 0, true);
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].name, 'Suco');
    assert.equal(first.total, 11);
    assert.equal(other.total, 55);
    assert.equal(env.saves(), 2);
    assert.equal(env.renders(), 2);
});

test('preserves no-service orders and recalculates legacy service without a stored percentage', async () => {
    const noService = order({ svc: 0, total: 50 });
    const legacy = order({ id: 2, sub: undefined, svc: 5, svcPct: undefined });
    const env = setup([noService, legacy]);
    await env.context.remove(1, 0, false);
    await env.context.remove(2, 0, false);
    assert.equal(noService.total, 30);
    assert.equal(legacy.svc, 3);
    assert.equal(legacy.total, 33);
});

test('removing the final item cancels only its order and preserves it in history', async () => {
    const first = order({ items: [{ name: 'Suco', qty: 1, price: 10 }], sub: 10, svc: 1, total: 11 });
    const other = order({ id: 2 });
    const env = setup([first, other]);
    await env.context.remove(1, 0, true);
    assert.equal(first.status, 'CANCELADO');
    assert.equal(first.items[0].name, 'Suco');
    assert.equal(other.status, 'PENDENTE');
    assert.equal(env.saves(), 1);
});

test('cancelled confirmation, paid orders and synchronization errors do not modify an order', async () => {
    const first = order();
    const declined = setup([first], { confirm: false });
    await declined.context.remove(1, 0, true);
    assert.equal(declined.saves(), 0);
    const paid = setup([order({ paid: true })]);
    await paid.context.remove(1, 0, true);
    assert.equal(paid.saves(), 0);
    const offline = setup([first], { online: true, sync: async () => false });
    await offline.context.remove(1, 0, true);
    assert.equal(first.items.length, 2);
    assert.equal(offline.saves(), 0);
    assert.match(offline.messages[0], /conexão/);
});

test('rejects stale changes after another device edits the order', async () => {
    const first = order();
    const env = setup([first], {
        online: true,
        sync: async () => { first.items.reverse(); return true; }
    });
    await env.context.remove(1, 0, true);
    assert.equal(first.items.length, 2);
    assert.equal(env.saves(), 0);
    assert.match(env.messages[0], /outro dispositivo/);
});

test('reports persistence failure rather than a successful update', async () => {
    const env = setup([order()], { saved: false });
    await env.context.remove(1, 0, true);
    assert.match(env.messages[0], /Não foi possível salvar/);
});
