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

function setupDispatch(overrides = {}) {
    const order = { id: 1, type: 'DELIVERY', status: 'PENDENTE', paid: true, taxa: 7 };
    const driver = { id: 'driver-1', name: 'Entregador 1' };
    const messages = [];
    let saves = 0;
    const context = {
        S: { orders: [order], deliveryDrivers: [driver], caixa: { id: 'cash-1', status: 'ABERTO', deliveries: [] } },
        currentUser: { name: 'Cozinha' },
        supabaseClient: null,
        deliveryDispatchPending: false,
        deliveryDriverUpdatePending: false,
        orderCancellationPending: false,
        cashStatusSyncPending: false,
        caixaAberto: () => context.S.caixa.status === 'ABERTO',
        $: () => ({ value: 'driver-1' }),
        syncSharedState: async () => true,
        renderAll() {},
        save: async () => { saves++; return true; },
        toast: message => messages.push(message),
        ...overrides
    };
    const dispatch = extract('        async function kdsDone(', '        function stLabel(', 'kdsDone', context);
    return { context, order, driver, messages, saves: () => saves, dispatch };
}

test('dispatch records the selected driver and fee once even for a paid delivery', async () => {
    const env = setupDispatch();
    await env.dispatch(1);
    assert.equal(env.order.status, 'PRONTO');
    assert.equal(env.order.deliveryDriver.name, 'Entregador 1');
    assert.deepEqual(JSON.parse(JSON.stringify(env.context.S.caixa.deliveries[0])), {
        orderId: 1, driverId: 'driver-1', driverName: 'Entregador 1', fee: 7, at: env.order.readyAt
    });
    await env.dispatch(1);
    assert.equal(env.context.S.caixa.deliveries.length, 1);
    assert.equal(env.saves(), 1);
});

test('dispatch requires an open cash session, a valid driver, and a valid fee', async () => {
    const closed = setupDispatch();
    closed.context.S.caixa.status = 'FECHADO';
    await closed.dispatch(1);
    assert.match(closed.messages[0], /Abra o caixa/);
    const missing = setupDispatch({ $: () => ({ value: '' }) });
    await missing.dispatch(1);
    assert.match(missing.messages[0], /Selecione um entregador/);
    const invalid = setupDispatch();
    invalid.order.taxa = -1;
    await invalid.dispatch(1);
    assert.match(invalid.messages[0], /taxa de entrega.*inválida/i);
    for (const env of [closed, missing, invalid]) {
        assert.equal(env.order.status, 'PENDENTE');
        assert.equal(env.saves(), 0);
    }
});

test('dispatch rejects stale orders and a cash session changed by another device', async () => {
    const stale = setupDispatch({ supabaseClient: {} });
    stale.context.syncSharedState = async () => { stale.order.taxa = 9; return true; };
    await stale.dispatch(1);
    assert.match(stale.messages[0], /outro dispositivo/);
    const cash = setupDispatch({ supabaseClient: {} });
    cash.context.syncSharedState = async () => { cash.context.S.caixa.id = 'cash-2'; return true; };
    await cash.dispatch(1);
    assert.match(cash.messages[0], /caixa foi alterado/);
    assert.equal(stale.saves(), 0);
    assert.equal(cash.saves(), 0);
});

test('cash report sums fees and delivery counts per driver without affecting sales or cash', () => {
    const context = { S: { orders: [] }, PAYS: ['Dinheiro', 'PIX'] };
    const summarize = extract('        function caixaResumo(', '        function caixaDateKey(', 'caixaResumo', context);
    const summary = summarize({
        initial: 5, movs: [],
        deliveries: [
            { driverId: 'a', driverName: 'Ana', fee: 7.1 },
            { driverId: 'a', driverName: 'Ana', fee: 8.2 },
            { driverId: 'b', driverName: 'Bia', fee: 0 }
        ]
    });
    assert.deepEqual(JSON.parse(JSON.stringify(summary.deliveryDrivers)), [
        { name: 'Ana', count: 2, fee: 15.3 },
        { name: 'Bia', count: 1, fee: 0 }
    ]);
    assert.equal(summary.sales, 0);
    assert.equal(summary.drawerCash, 5);
    assert.deepEqual(JSON.parse(JSON.stringify(summarize({ movs: [] }).deliveryDrivers)), []);
});

test('delivery cannot be paid before dispatch and requires confirmation after dispatch', () => {
    const orders = [
        { id: 1, type: 'DELIVERY', status: 'PENDENTE', total: 17, items: [] },
        { id: 2, type: 'BALCAO', status: 'PENDENTE', total: 10, items: [] }
    ];
    const context = {
        S: { orders, caixa: { movs: [] } },
        orderCancellationPending: false,
        pendingPaymentTarget: { mesaNumber: null, orderIds: ['1', '2'] },
        caixaAberto: () => true,
        isOrderOpen: order => !order.paid,
        readPaymentDraft: () => ({ result: { payments: [{ method: 'PIX', amountCents: 2700 }], remainingCents: 0, changeCents: 0 } }),
        where: () => 'Delivery',
        money: String,
        closePaymentModal() {},
        renderAll() {},
        toast() {},
        confirm: () => true
    };
    const confirmPayment = extract('        function confirmOrderPayment(', '        function cancelOrder(', 'confirmOrderPayment', context);
    confirmPayment();
    assert.equal(orders[0].paid, undefined);
    assert.equal(context.S.caixa.movs.length, 0);
    orders[0].status = 'PRONTO';
    context.confirm = () => false;
    confirmPayment();
    assert.equal(orders[0].paid, undefined);
    assert.equal(context.S.caixa.movs.length, 0);
    context.confirm = () => true;
    confirmPayment();
    assert.equal(orders[0].paid, true);
    assert.equal(orders[0].status, 'PRONTO');
    assert.equal(orders[1].status, 'PRONTO');
    assert.equal(context.S.caixa.movs.length, 2);
});

test('clearing order history retains paid deliveries still awaiting dispatch', () => {
    const context = {
        S: {
            orders: [
                { id: 1, type: 'DELIVERY', paid: true, status: 'PENDENTE' },
                { id: 2, type: 'DELIVERY', paid: true, status: 'PRONTO' }
            ],
            caixa: { movs: [] }, caixaHistory: []
        },
        isAdmin: () => true,
        isOrderOpen: order => !order.paid && order.status !== 'CANCELADO',
        confirm: () => true,
        renderAll() {},
        save: async () => true,
        toast() {}
    };
    const clearHistory = extract('        function limparHistoricoPedidos(', '        function toggleOrderDetails(', 'limparHistoricoPedidos', context);
    clearHistory();
    assert.deepEqual(context.S.orders.map(order => order.id), [1]);
    assert.deepEqual(Array.from(context.S.deletedOrderHistoryIds), ['2']);
});

test('driver records can be added, renamed and removed without changing past delivery records', async () => {
    const input = { value: 'Ana' };
    const messages = [];
    const context = {
        S: { deliveryDrivers: [], caixa: { deliveries: [] } },
        deliveryDriverUpdatePending: false,
        deliveryDispatchPending: false,
        canManagePromotions: () => true,
        supabaseClient: null,
        window: { crypto: { randomUUID: () => 'new-driver' } },
        $: () => input,
        prompt: () => 'Ana Maria',
        confirm: () => true,
        renderAll() {},
        save: async () => true,
        toast: message => messages.push(message)
    };
    const update = extract('        function renderEntregadores(', '        // ===================== CARDÁPIO', 'atualizarEntregador', context);
    await update('adicionar');
    assert.equal(context.S.deliveryDrivers[0].name, 'Ana');
    context.S.caixa.deliveries.push({ driverId: 'new-driver', driverName: 'Ana', fee: 7 });
    await update('editar', 0);
    assert.equal(context.S.deliveryDrivers[0].name, 'Ana Maria');
    await update('remover', 0);
    assert.equal(context.S.deliveryDrivers.length, 0);
    assert.equal(context.S.caixa.deliveries[0].driverName, 'Ana');
    assert.equal(messages.length, 3);
});

test('selecting a delivery customer restores the six-real fee', () => {
    const elements = {};
    const context = {
        S: { clientes: [{ id: 1, cli: 'Cliente', tel: '', end: 'Rua', bairro: 'Centro', taxa: 6 }] },
        $: id => elements[id] || (elements[id] = { value: '', classList: { add() {}, remove() {} } }),
        formatBrazilPhone: value => value,
        esc: value => value,
        renderCart() {},
        cliLoaded: false
    };
    const selectCustomer = extract('        function selCli(', '        function renderClientes(', 'selCli', context);
    selectCustomer(1);
    assert.equal(elements['o-taxa'].value, '6');
    context.S.clientes[0].taxa = 99;
    selectCustomer(1);
    assert.equal(elements['o-taxa'].value, '7');
});
