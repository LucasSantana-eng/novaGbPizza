const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extract(start, end, name, context) {
    const first = html.indexOf(start);
    const last = html.indexOf(end, first);
    assert.ok(first !== -1 && last !== -1);
    vm.runInNewContext(`${html.slice(first, last)}\nthis.fn = ${name};`, context);
    return context.fn;
}

function setup(order, options = {}) {
    const messages = [];
    const confirmations = [];
    let saves = 0;
    const context = {
        S: {
            orders: [order],
            caixa: { id: 'open', status: 'ABERTO', movs: options.movs || [], deliveries: options.deliveries || [] },
            caixaHistory: options.history || []
        },
        currentUser: { name: 'Operador' },
        supabaseClient: options.online ? {} : null,
        orderCancellationPending: false,
        deliveryDispatchPending: false,
        cashStatusSyncPending: false,
        caixaAberto: () => context.S.caixa.status !== 'FECHADO',
        syncSharedState: options.sync || (async () => true),
        confirm: message => { confirmations.push(message); return options.confirm !== false; },
        renderAll(persist) { assert.equal(persist, false); },
        save: async () => { saves++; return options.saved !== false; },
        toast: message => messages.push(message),
        qzSettings: { options: { printCancellation: false } },
        printThermal() { throw new Error('Unexpected print'); }
    };
    const cancel = extract('        async function cancelOrderAsync(', '        async function kdsDone(', 'cancelOrderAsync', context);
    return { context, cancel, messages, confirmations, saves: () => saves };
}

test('unpaid delivery and pickup can be cancelled without changing cash', async () => {
    for (const order of [
        { id: 1, type: 'DELIVERY', status: 'PENDENTE', paid: false },
        { id: 1, type: 'BALCAO', serviceType: 'RETIRADA', status: 'PENDENTE', paid: false }
    ]) {
        const env = setup(order);
        await env.cancel(1);
        assert.equal(order.status, 'CANCELADO');
        assert.equal(env.context.S.caixa.movs.length, 0);
        assert.equal(env.saves(), 1);
    }
});

test('corrects accidentally recorded split payments without treating them as refunds', async () => {
    const order = { id: 2, type: 'DELIVERY', status: 'PENDENTE', paid: true, total: 25 };
    const env = setup(order, { movs: [
        { type: 'Venda', orderId: 2, pay: 'PIX', v: 10 },
        { type: 'Venda', orderId: 2, pay: 'Dinheiro', v: 15 },
        { type: 'Venda', orderId: 3, pay: 'PIX', v: 8 }
    ] });
    await env.cancel(2);
    assert.match(env.confirmations[0], /NÃO foi recebido/);
    assert.match(env.confirmations[0], /não devolve dinheiro/);
    assert.equal(order.status, 'CANCELADO');
    assert.equal(order.paid, false);
    assert.equal(order.paymentCorrection.reason, 'Pagamento não recebido');
    assert.deepEqual(env.context.S.caixa.movs.map(movement => movement.type), ['Venda cancelada', 'Venda cancelada', 'Venda']);
    const summaryContext = { S: { orders: [order, { id: 3, type: 'BALCAO', total: 8, sub: 8 }] }, PAYS: ['PIX', 'Dinheiro'] };
    const summarize = extract('        function caixaResumo(', '        function caixaDateKey(', 'caixaResumo', summaryContext);
    const summary = summarize(env.context.S.caixa);
    assert.equal(summary.sales, 8);
    assert.equal(summary.drawerCash, 0);
    assert.equal(summary.byPayment.PIX, 8);
});

test('refuses to modify paid orders when cash records are missing, incomplete or in a closed session', async () => {
    for (const options of [
        {},
        { movs: [{ type: 'Venda', orderId: 2, v: 10 }] },
        { history: [{ movs: [{ type: 'Venda', orderId: 2, v: 25 }] }] }
    ]) {
        const order = { id: 2, type: 'BALCAO', serviceType: 'RETIRADA', status: 'PENDENTE', paid: true, total: 25 };
        const env = setup(order, options);
        await env.cancel(2);
        assert.equal(order.status, 'PENDENTE');
        assert.equal(order.paid, true);
        assert.equal(env.saves(), 0);
        assert.match(env.messages[0], /manual/);
    }
});

test('cannot cancel a dispatched delivery or remove its driver fee', async () => {
    const order = { id: 3, type: 'DELIVERY', status: 'PRONTO', paid: false, deliveryDriver: { id: 'a', name: 'Ana' } };
    const delivery = { orderId: 3, driverId: 'a', driverName: 'Ana', fee: 6 };
    const env = setup(order, { deliveries: [delivery] });
    await env.cancel(3);
    assert.equal(env.context.S.caixa.deliveries.length, 1);
    assert.equal(order.status, 'PRONTO');
    assert.match(env.messages[0], /produção/);
    const closedOrder = { ...order, status: 'PRONTO' };
    const closed = setup(closedOrder, { history: [{ deliveries: [delivery] }] });
    await closed.cancel(3);
    assert.equal(closedOrder.status, 'PRONTO');
    assert.equal(closed.saves(), 0);
    assert.match(closed.messages[0], /produção/);
});

test('declining confirmation or a stale shared state leaves the order untouched', async () => {
    const declinedOrder = { id: 1, type: 'DELIVERY', status: 'PENDENTE', paid: false };
    const declined = setup(declinedOrder, { confirm: false });
    await declined.cancel(1);
    assert.equal(declinedOrder.status, 'PENDENTE');
    assert.equal(declined.saves(), 0);
    const staleOrder = { id: 1, type: 'DELIVERY', status: 'PENDENTE', paid: false };
    const stale = setup(staleOrder, { online: true });
    stale.context.syncSharedState = async () => { staleOrder.paid = true; return true; };
    await stale.cancel(1);
    assert.equal(staleOrder.status, 'PENDENTE');
    assert.equal(stale.saves(), 0);
    assert.match(stale.messages[0], /outro dispositivo/);
});
