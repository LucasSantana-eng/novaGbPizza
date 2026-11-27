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
        window: { GabryelleMesa: require('../mesa-conta-compartilhada.js') },
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

test('cashier additions consolidate open orders while preserving kitchen batches and 10% of the whole table', () => {
    const shared = require('../mesa-conta-compartilhada.js');
    let counter = 0;
    const context = {
        S: { seq: 10, orders: [], menu: { svc: 10 } },
        window: { GabryelleMesa: shared, crypto: { randomUUID: () => `batch-${++counter}` } },
        $: () => ({ checked: true }), caixaAberto: () => true,
        isOrderOpen: entry => !entry.paid && entry.status !== 'CANCELADO',
        renderAll() {}, toast(message) { throw new Error(message); }
    };
    const start = html.indexOf('        function finalize(');
    const end = html.indexOf('        function payOrder(', start);
    vm.runInNewContext(`${html.slice(start, end)}\nthis.finalize = finalize;`, context);
    const make = price => ({ type: 'MESA', mesa: 2, items: [{ name: 'Produto', qty: 1, price, det: [], obs: '' }], taxa: 0, by: 'Caixa', printRequested: true });
    const first = make(43);
    context.finalize(first, 'Pagar depois');
    context.S.orders[0].tableBatches[0].status = 'PRONTO';
    context.S.orders[0].status = 'PRONTO';
    const second = make(6);
    context.finalize(second, 'Pagar depois');
    const third = make(6);
    context.finalize(third, 'Pagar depois');
    assert.equal(context.S.orders.length, 1);
    const result = context.S.orders[0];
    assert.equal(result.id, first.id);
    assert.equal(second.id, first.id);
    assert.equal(third.id, first.id);
    assert.equal(result.sub, 55);
    assert.equal(result.svc, 5.5);
    assert.equal(result.total, 60.5);
    assert.deepEqual(Array.from(result.tableBatches, batch => batch.status), ['PRONTO', 'PENDENTE', 'PENDENTE']);
    assert.equal(second.items.length, 1);
    assert.equal(second.tableBatchPrintId, 'batch-2');
});

test('legacy orders consolidate with historical snapshots and service rounded over the combined subtotal', () => {
    const shared = require('../mesa-conta-compartilhada.js');
    const entries = [
        order({ items: [{ name: 'A', qty: 1, price: 0.05 }], sub: 0.05, svc: 0.01, total: 0.06, status: 'PRONTO' }),
        order({ id: 2, items: [{ name: 'B', qty: 2, price: 0.05 }], sub: 0.1, svc: 0.01, total: 0.11 })
    ];
    const merged = shared.consolidateTableOrders(entries, 2, 10);
    assert.equal(merged.id, 1);
    assert.equal(merged.sub, 0.15);
    assert.equal(merged.svc, 0.02);
    assert.equal(merged.total, 0.17);
    assert.deepEqual(merged.tableOriginalOrders.map(entry => entry.id), [1, 2]);
    assert.deepEqual(merged.tableBatches.map(entry => entry.status), ['PRONTO', 'PENDENTE']);
    assert.equal(merged.tableBatches[0].printRequested, false);
    assert.equal(entries[0].items[0].tableBatchId, undefined);
});

test('removing an item recalculates service and removes its empty kitchen batch from pending', async () => {
    const combined = order({
        items: [
            { name: 'A', qty: 1, price: 0.05, tableBatchId: 'a' },
            { name: 'B', qty: 3, price: 0.05, tableBatchId: 'b' }
        ],
        tableBatches: [{ id: 'a', status: 'PENDENTE' }, { id: 'b', status: 'PRONTO' }],
        sub: 0.2, svc: 0.02, svcPct: 10, serviceEnabled: true, total: 0.22
    });
    const env = setup([combined]);
    await env.context.remove(1, 0, true);
    assert.equal(combined.sub, 0.15);
    assert.equal(combined.svc, 0.02);
    assert.equal(combined.total, 0.17);
    assert.equal(combined.status, 'PRONTO');
});

test('marking one kitchen batch ready leaves newer additions pending', async () => {
    const table = order({
        items: [
            { name: 'Pizza', qty: 1, price: 20, det: [], tableBatchId: 'a' },
            { name: 'Suco', qty: 1, price: 10, det: [], tableBatchId: 'b' }
        ],
        tableBatches: [{ id: 'a', status: 'PENDENTE' }, { id: 'b', status: 'PENDENTE' }]
    });
    const context = {
        S: { orders: [table] }, kdsTableUpdatePending: false,
        deliveryEditPending: false, deliveryDispatchPending: false,
        deliveryDriverUpdatePending: false, orderCancellationPending: false,
        supabaseClient: null, renderAll() {}, save: async () => true,
        toast(message) { throw new Error(message); }
    };
    const start = html.indexOf('        async function kdsDone(');
    const end = html.indexOf('        function stLabel(', start);
    vm.runInNewContext(`${html.slice(start, end)}\nthis.done = kdsDone;`, context);
    await context.done(1, 0);
    assert.equal(table.tableBatches[0].status, 'PRONTO');
    assert.equal(table.tableBatches[1].status, 'PENDENTE');
    assert.equal(table.status, 'PENDENTE');
    await context.done(1, 1);
    assert.equal(table.status, 'PRONTO');
});

test('removing grouped items targets the latest unit and keeps different observations separate', async () => {
    const table = order({
        items: [
            { name: 'Suco', qty: 1, price: 10, det: [], obs: '', tableBatchId: 'old' },
            { name: 'Suco', qty: 2, price: 10, det: [], obs: '', tableBatchId: 'new' },
            { name: 'Suco', qty: 1, price: 10, det: [], obs: 'Sem gelo', tableBatchId: 'new' }
        ],
        tableBatches: [{ id: 'old', status: 'PRONTO' }, { id: 'new', status: 'PENDENTE' }],
        sub: 40, svc: 4, svcPct: 10, serviceEnabled: true, total: 44
    });
    const env = setup([table]);
    await env.context.remove(1, 0, false);
    assert.equal(table.items[0].qty, 1);
    assert.equal(table.items[1].qty, 1);
    assert.equal(table.total, 33);
    await env.context.remove(1, 0, true);
    assert.equal(table.items.length, 1);
    assert.equal(table.items[0].obs, 'Sem gelo');
    assert.equal(table.total, 11);
});
