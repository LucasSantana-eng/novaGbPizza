const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function setup(role = 'CAIXA') {
    const order = {
        id: 1, type: 'DELIVERY', status: 'PENDENTE', paid: false,
        cli: 'Cliente', end: 'Rua 1', bairro: 'Centro', tel: '',
        items: [{ name: 'Pizza Média', qty: 1, price: 30, det: ['Queijo'], obs: '' }],
        taxa: 6, sub: 30, total: 36, payPref: 'Dinheiro', needsChange: true, cashChangeFor: 50
    };
    const elements = {};
    for (const [id, value] of Object.entries({
        'delivery-edit-cli': 'Cliente', 'delivery-edit-end': 'Rua 2', 'delivery-edit-tel': '',
        'delivery-edit-bairro': 'Centro', 'delivery-edit-taxa': '7', 'delivery-edit-change': '50'
    })) elements[id] = { value };
    elements['delivery-edit-modal'] = { classList: { add() {}, remove() {} } };
    elements['delivery-edit-menu'] = { querySelector: () => null };
    const messages = [];
    const context = {
        S: { orders: [order, { id: 2, total: 10 }] }, currentUser: { role, id: 3, name: 'Operador' },
        deliveryEditDraft: { id: '1', snapshot: JSON.stringify(order), items: [{ ...order.items[0], price: 40 }], pizzaIndex: null },
        deliveryEditPending: false, cashStatusSyncPending: false, deliveryDispatchPending: false, orderCancellationPending: false,
        canHandleOnlineOrders: () => ['ADMIN', 'GERENTE', 'CAIXA'].includes(context.currentUser.role),
        isAdmin: () => context.currentUser.role === 'ADMIN',
        caixaAberto: () => context.S.caixa?.status === 'ABERTO',
        PAYS: ['Dinheiro', 'PIX', 'Cartão de Crédito', 'Cartão de Débito'],
        money: String, prompt: () => '2',
        supabaseClient: null, syncSharedState: async () => true,
        formatBrazilPhone: value => value, $: id => elements[id],
        confirm: () => true, toast: message => messages.push(message), renderAll() {}, save: async () => true,
        printDeliveryChange: async () => true
    };
    const start = html.indexOf('        function openDeliveryEdit(');
    const end = html.indexOf('        function renderAll(', start);
    assert.ok(start !== -1 && end !== -1);
    vm.runInNewContext(`${html.slice(start, end)}\nthis.saveEdit = saveDeliveryEdit;`, context);
    return { context, order, elements, messages };
}

test('delivery editor opens each category in a separate selection and adds checked products', () => {
    const env = setup();
    const menu = [
        { n: 'Pizza Calabresa', c: 'Pizzas', pz: 0 },
        { n: 'Batata frita', c: 'Petiscos', p: 18, d: 'Porção' },
        { n: 'Prato do dia', c: 'Restaurante', p: 25 },
        { n: 'Refrigerante', c: 'Bebidas', p: 7 },
        { n: 'Suco', c: 'Bebidas', p: 6 },
        { n: 'Sem preço', c: 'Petiscos', p: 0 }
    ];
    const selected = [3, 4].map(index => ({ dataset: { deliveryMenuIndex: String(index) }, checked: true }));
    const menuItems = { innerHTML: '', querySelectorAll: () => selected };
    const classes = new Set(['hidden']);
    const modal = { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
    env.elements['delivery-menu-modal'] = modal;
    env.elements['delivery-menu-items'] = menuItems;
    env.elements['delivery-menu-title'] = {};
    env.elements['delivery-menu-search'] = {};
    env.elements['delivery-menu-empty'] = { classList: { add() {} } };
    for (const id of ['delivery-edit-title', 'delivery-edit-items']) env.elements[id] = {};
    env.context.menuItems = () => menu;
    env.context.esc = String;
    env.context.openDeliveryEdit(1);
    const markup = env.elements['delivery-edit-menu'].innerHTML;
    assert.match(markup, /Petiscos/);
    assert.match(markup, /Restaurante/);
    assert.match(markup, /Bebidas/);
    assert.doesNotMatch(markup, /Refrigerante/);
    assert.doesNotMatch(markup, /Pizza Calabresa/);
    env.context.openDeliveryMenu(0);
    assert.equal(env.elements['delivery-menu-title'].textContent, 'Petiscos');
    assert.match(menuItems.innerHTML, /Batata frita/);
    assert.match(menuItems.innerHTML, /data-delivery-menu-index="5" disabled/);
    env.context.closeDeliveryMenu();
    env.context.openDeliveryMenu(2);
    assert.equal(env.elements['delivery-menu-title'].textContent, 'Bebidas');
    assert.match(menuItems.innerHTML, /Refrigerante/);
    assert.match(menuItems.innerHTML, /Suco/);
    assert.doesNotMatch(menuItems.innerHTML, /Batata/);
    assert.equal(classes.has('hidden'), false);
    env.context.deliveryEditAddItems();
    assert.deepEqual(JSON.parse(JSON.stringify(env.context.deliveryEditDraft.items.slice(1))), [
        { name: 'Refrigerante', category: 'Bebidas', qty: 1, price: 7, det: [], obs: '' },
        { name: 'Suco', category: 'Bebidas', qty: 1, price: 6, det: [], obs: '' }
    ]);
    assert.equal(classes.has('hidden'), true);
});

test('open product selector must be completed or closed before saving', async () => {
    const env = setup();
    env.context.deliveryEditDraft.menuCategory = 'Bebidas';
    await env.context.saveEdit();
    assert.equal(env.order.total, 36);
    assert.match(env.messages[0], /seleção de produtos/);
});

test('filtering products ignores accents and keeps hidden selections', () => {
    const env = setup();
    const makeLabel = text => ({
        textContent: text,
        checked: true,
        hidden: false,
        classList: { toggle(_className, hidden) { this.owner.hidden = hidden; } }
    });
    const labels = [makeLabel('Refrigerante'), makeLabel('Suco de limão')];
    labels.forEach(label => { label.classList.owner = label; });
    env.elements['delivery-menu-items'] = { querySelectorAll: () => labels };
    env.elements['delivery-menu-search'] = { value: 'limao' };
    env.elements['delivery-menu-empty'] = { classList: { toggle() {} } };
    env.context.filterDeliveryMenuItems();
    assert.equal(labels[0].hidden, true);
    assert.equal(labels[1].hidden, false);
    assert.equal(labels[0].checked, true);
});

test('authorized delivery edit updates items, total and address without changing other orders', async () => {
    for (const role of ['ADMIN', 'GERENTE', 'CAIXA']) {
        const env = setup(role);
        await env.context.saveEdit();
        assert.equal(env.order.items[0].price, 40);
        assert.equal(env.order.sub, 40);
        assert.equal(env.order.total, 47);
        assert.equal(env.order.end, 'Rua 2');
        assert.equal(env.order.cashChangeFor, 50);
        assert.equal(env.order.editHistory[0].before.total, 36);
        assert.equal(env.context.S.orders[1].total, 10);
    }
});

test('invalid change, unauthorized role and concurrent order edits do not mutate delivery', async () => {
    const invalid = setup();
    invalid.elements['delivery-edit-change'].value = '40';
    await invalid.context.saveEdit();
    assert.equal(invalid.order.total, 36);
    assert.match(invalid.messages[0], /troco/);
    const denied = setup('GARCOM');
    await denied.context.saveEdit();
    assert.equal(denied.order.total, 36);
    assert.match(denied.messages[0], /administrador/);
    const stale = setup();
    stale.context.supabaseClient = {};
    stale.context.syncSharedState = async () => { stale.order.status = 'PRONTO'; return true; };
    await stale.context.saveEdit();
    assert.equal(stale.order.total, 36);
    assert.match(stale.messages[0], /mudou/);
});

test('replacing a pizza uses the existing pizza builder without modifying the new-order cart', () => {
    const context = {
        pm: { fl: ['Queijo'], ac: [], q: 1, s: 2, o: '' }, SIZES: ['Pequena', 'Média', 'Grande'],
        S: { menu: { pt: [10, 20, 40], pd: [10, 20, 40], ac: [] } },
        deliveryEditDraft: { items: [{ name: 'Pizza Média' }], pizzaIndex: 0 },
        pizzaIsSweet: () => false, isMixedPizza: () => false, pmPrice: () => 40,
        addCart() { throw new Error('The unrelated new-order cart must not be changed'); },
        renderDeliveryEditItems() {}, closePizza() {}, toast(message) { throw new Error(message); }
    };
    const start = html.indexOf('        function addPizza()');
    const end = html.indexOf('        // ---------- Carrinho ----------', start);
    vm.runInNewContext(`${html.slice(start, end)}\nthis.add = addPizza;`, context);
    context.add();
    assert.equal(context.deliveryEditDraft.items[0].name, 'Pizza Grande');
    assert.equal(context.deliveryEditDraft.items[0].price, 40);
});

test('editing a dispatched delivery keeps its driver and updates the open cash fee', async () => {
    const env = setup();
    env.order.status = 'PRONTO';
    env.order.deliveryDriver = { id: 'a', name: 'Ana' };
    const delivery = { orderId: 1, driverId: 'a', driverName: 'Ana', fee: 6 };
    env.context.S.caixa = { id: 1, status: 'ABERTO', deliveries: [delivery] };
    env.context.S.caixaHistory = [];
    env.context.deliveryEditDraft.snapshot = JSON.stringify(env.order);
    let printed;
    env.context.printDeliveryChange = async (id, index) => { printed = [id, index]; return true; };
    await env.context.saveEdit();
    assert.equal(env.order.status, 'PRONTO');
    assert.equal(env.order.deliveryDriver.id, 'a');
    assert.equal(delivery.fee, 7);
    assert.equal(delivery.feeCorrections[0].from, 6);
    assert.deepEqual(printed, [1, 0]);
    assert.equal(env.order.editHistory[0].before.items[0].price, 30);
    assert.equal(env.order.editHistory[0].after.items[0].price, 40);
});

test('closed-session delivery fee correction preserves the original and is audited', async () => {
    const env = setup();
    env.order.status = 'PRONTO';
    env.order.deliveryDriver = { id: 'a', name: 'Ana' };
    const delivery = { orderId: 1, driverId: 'a', driverName: 'Ana', fee: 6 };
    const history = { id: 1, status: 'FECHADO', deliveries: [delivery], summary: { deliveryDrivers: [{ name: 'Ana', count: 1, fee: 6 }] } };
    env.context.S.caixa = { id: 2, status: 'ABERTO' };
    env.context.S.caixaHistory = [history];
    env.context.deliveryEditDraft.snapshot = JSON.stringify(env.order);
    await env.context.saveEdit();
    assert.equal(delivery.fee, 6);
    assert.equal(history.summary.deliveryDrivers[0].fee, 6);
    assert.equal(history.deliveryFeeCorrections[0].to, 7);
    assert.equal(history.deliveryFeeCorrections[0].by, 'Operador');
});

test('missing driver record, unauthorized paid total change and print failure are explicit', async () => {
    const missing = setup();
    missing.order.status = 'PRONTO';
    missing.order.deliveryDriver = { id: 'a' };
    missing.context.deliveryEditDraft.snapshot = JSON.stringify(missing.order);
    await missing.context.saveEdit();
    assert.equal(missing.order.total, 36);
    assert.match(missing.messages[0], /taxa do entregador/);

    const paid = setup();
    paid.order.status = 'PRONTO';
    paid.order.paid = true;
    paid.context.deliveryEditDraft.snapshot = JSON.stringify(paid.order);
    await paid.context.saveEdit();
    assert.equal(paid.order.total, 36);
    assert.match(paid.messages[0], /administrador/);

    const failure = setup();
    failure.context.printDeliveryChange = async () => false;
    await failure.context.saveEdit();
    assert.equal(failure.order.total, 47);
    assert.match(failure.messages[0], /comanda não foi confirmada/);
});

test('paid delivery changes register an actual receipt or refund in the open cash', async () => {
    for (const [price, expectedAmount, method, expectedTotal] of [[40, 10, 'PIX', 46], [20, -10, 'Dinheiro', 26]]) {
        const env = setup('ADMIN');
        env.order.status = 'PRONTO';
        env.order.paid = true;
        env.order.deliveryDriver = { id: 'a', name: 'Ana' };
        env.elements['delivery-edit-taxa'].value = '6';
        env.elements['delivery-edit-change'].value = '';
        env.context.deliveryEditDraft.items[0].price = price;
        env.context.deliveryEditDraft.snapshot = JSON.stringify(env.order);
        env.context.S.caixa = {
            id: 1, status: 'ABERTO', initial: 5,
            movs: [{ type: 'Venda', orderId: 1, orderType: 'DELIVERY', pay: 'Dinheiro', v: 36 }],
            deliveries: [{ orderId: 1, driverId: 'a', driverName: 'Ana', fee: 6 }]
        };
        env.context.S.caixaHistory = [];
        env.context.prompt = () => method === 'PIX' ? '2' : '1';
        await env.context.saveEdit();
        const adjustment = env.context.S.caixa.movs[1];
        assert.equal(adjustment.type, 'Ajuste delivery');
        assert.equal(adjustment.v, expectedAmount);
        assert.equal(adjustment.pay, method);
        assert.equal(adjustment.correctedBy, 'Operador');
        assert.equal(env.order.total, expectedTotal);
        assert.equal(env.order.status, 'PRONTO');
        const start = html.indexOf('        function caixaResumo(');
        const end = html.indexOf('        function caixaDateKey(', start);
        vm.runInNewContext(`${html.slice(start, end)}\nthis.summarize = caixaResumo;`, env.context);
        const summary = env.context.summarize(env.context.S.caixa);
        assert.equal(summary.sales, expectedTotal);
        assert.equal(summary.delivery.total, expectedTotal);
        assert.equal(summary.delivery.products, price);
        assert.equal(summary.delivery.deliveryFee, 6);
        assert.equal(summary.byPayment[method], method === 'Dinheiro' ? expectedTotal : expectedAmount);
        assert.equal(summary.drawerCash, method === 'Dinheiro' ? 5 + expectedTotal : 41);
    }
});

test('paid delivery with a prior closed sale posts only the difference to the new cash session', async () => {
    const env = setup('ADMIN');
    env.order.status = 'PRONTO';
    env.order.paid = true;
    env.elements['delivery-edit-taxa'].value = '6';
    env.elements['delivery-edit-change'].value = '';
    env.context.deliveryEditDraft.snapshot = JSON.stringify(env.order);
    const old = { id: 1, status: 'FECHADO', movs: [{ type: 'Venda', orderId: 1, pay: 'PIX', v: 36 }], summary: { sales: 36 } };
    env.context.S.caixaHistory = [old];
    env.context.S.caixa = { id: 2, status: 'ABERTO', initial: 0, movs: [] };
    await env.context.saveEdit();
    assert.equal(env.context.S.caixa.movs[0].v, 10);
    assert.equal(old.summary.sales, 36);
    const start = html.indexOf('        function caixaResumo(');
    const end = html.indexOf('        function caixaDateKey(', start);
    vm.runInNewContext(`${html.slice(start, end)}\nthis.summarize = caixaResumo;`, env.context);
    const summary = env.context.summarize(env.context.S.caixa);
    assert.equal(summary.sales, 10);
    assert.equal(summary.delivery.products, 10);
    assert.equal(summary.delivery.deliveryFee, 0);
    assert.equal(summary.byPayment.PIX, 10);
});

test('paid edits reject missing payment records and do not persist if cash changed remotely', async () => {
    const missing = setup('ADMIN');
    missing.order.status = 'PRONTO';
    missing.order.paid = true;
    missing.elements['delivery-edit-taxa'].value = '6';
    missing.elements['delivery-edit-change'].value = '';
    missing.context.deliveryEditDraft.snapshot = JSON.stringify(missing.order);
    missing.context.S.caixa = { id: 1, status: 'ABERTO', movs: [] };
    await missing.context.saveEdit();
    assert.equal(missing.order.total, 36);
    assert.match(missing.messages[0], /pagamentos anteriores/);

    const stale = setup('ADMIN');
    stale.order.status = 'PRONTO';
    stale.order.paid = true;
    stale.elements['delivery-edit-taxa'].value = '6';
    stale.elements['delivery-edit-change'].value = '';
    stale.context.deliveryEditDraft.snapshot = JSON.stringify(stale.order);
    stale.context.S.caixa = { id: 1, status: 'ABERTO', movs: [{ type: 'Venda', orderId: 1, pay: 'PIX', v: 36 }] };
    stale.context.supabaseClient = {};
    stale.context.syncSharedState = async () => { stale.context.S.caixa.movs[0].v = 35; return true; };
    await stale.context.saveEdit();
    assert.equal(stale.order.total, 36);
    assert.equal(stale.context.S.caixa.movs.length, 1);
    assert.match(stale.messages[0], /caixa.*mudou/);
});

test('a same-total paid edit records product and fee reclassification without taking payment', async () => {
    const env = setup('GERENTE');
    env.order.status = 'PRONTO';
    env.order.paid = true;
    env.order.deliveryDriver = { id: 'a', name: 'Ana' };
    env.elements['delivery-edit-change'].value = '';
    env.context.deliveryEditDraft.items[0].price = 29;
    env.context.deliveryEditDraft.snapshot = JSON.stringify(env.order);
    env.context.S.caixaHistory = [{
        id: 1, status: 'FECHADO', summary: { deliveryDrivers: [{ name: 'Ana', count: 1, fee: 6 }] },
        movs: [{ type: 'Venda', orderId: 1, pay: 'PIX', v: 36 }],
        deliveries: [{ orderId: 1, driverId: 'a', driverName: 'Ana', fee: 6 }]
    }];
    env.context.S.caixa = { id: 2, status: 'ABERTO', initial: 0, movs: [] };
    env.context.prompt = () => { throw new Error('No payment should be requested'); };
    await env.context.saveEdit();
    const movement = env.context.S.caixa.movs[0];
    assert.equal(movement.v, 0);
    assert.equal(movement.productDifference, -1);
    assert.equal(movement.feeDifference, 1);
    assert.equal(env.context.S.caixaHistory[0].deliveryFeeCorrections[0].to, 7);
    const start = html.indexOf('        function caixaResumo(');
    const end = html.indexOf('        function caixaDateKey(', start);
    vm.runInNewContext(`${html.slice(start, end)}\nthis.summarize = caixaResumo;`, env.context);
    const summary = env.context.summarize(env.context.S.caixa);
    assert.equal(summary.sales, 0);
    assert.equal(summary.delivery.products, -1);
    assert.equal(summary.delivery.deliveryFee, 1);
});

test('paid edits update a closed driver fee and record the real difference in the current cash', async () => {
    const env = setup('ADMIN');
    env.order.status = 'PRONTO';
    env.order.paid = true;
    env.order.deliveryDriver = { id: 'a', name: 'Ana' };
    env.elements['delivery-edit-change'].value = '';
    env.context.deliveryEditDraft.snapshot = JSON.stringify(env.order);
    const closed = {
        id: 1, status: 'FECHADO', summary: { sales: 36, deliveryDrivers: [{ name: 'Ana', count: 1, fee: 6 }] },
        movs: [{ type: 'Venda', orderId: 1, pay: 'Dinheiro', v: 36 }],
        deliveries: [{ orderId: 1, driverId: 'a', driverName: 'Ana', fee: 6 }]
    };
    env.context.S.caixaHistory = [closed];
    env.context.S.caixa = { id: 2, status: 'ABERTO', initial: 0, movs: [] };
    await env.context.saveEdit();
    assert.equal(env.context.S.caixa.movs[0].v, 11);
    assert.equal(env.context.S.caixa.movs[0].productDifference, 10);
    assert.equal(env.context.S.caixa.movs[0].feeDifference, 1);
    assert.equal(closed.deliveryFeeCorrections[0].to, 7);
    assert.equal(closed.summary.sales, 36);
    assert.equal(closed.summary.deliveryDrivers[0].fee, 6);
});

test('the change ticket includes only removed and added items, including removed sectors', async () => {
    let printed;
    const before = [
        { name: 'Pizza Média', category: 'Pizzas', qty: 1, det: ['Queijo'] },
        { name: 'Suco', category: 'Bar', qty: 1, det: [] }
    ];
    const after = [
        { name: 'Pizza Grande', category: 'Pizzas', qty: 1, det: ['Queijo'] },
        { name: 'Suco', category: 'Bar', qty: 1, det: [] }
    ];
    const order = { id: 1, editHistory: [{ at: 1, by: 'Caixa', before: { items: before }, after: { items: after } }] };
    const context = {
        S: { orders: [order] },
        productionPrintBatches: job => [job],
        printThermal: async (type, id, job) => { printed = { type, id, job }; return true; },
        toast(message) { throw new Error(message); }
    };
    const start = html.indexOf('        function deliveryChangeItems(');
    const end = html.indexOf('        async function printBothThermal(', start);
    vm.runInNewContext(`${html.slice(start, end)}\nthis.printChange = printDeliveryChange;`, context);
    assert.equal(await context.printChange(1, 0), true);
    assert.equal(printed.type, 'kitchen');
    assert.deepEqual(JSON.parse(JSON.stringify(printed.job.items.map(item => [item.name, item.editAction]))), [
        ['Pizza Média', 'REMOVER / CANCELAR'], ['Pizza Grande', 'ADICIONAR']
    ]);
});

test('corrected driver totals use the latest correction without changing original records', () => {
    const context = {};
    const start = html.indexOf('        function correctedDeliveryDrivers(');
    const end = html.indexOf('        function cashPaymentMethod(', start);
    vm.runInNewContext(`${html.slice(start, end)}\nthis.corrected = correctedDeliveryDrivers;`, context);
    const session = {
        deliveries: [{ orderId: 1, driverId: 'a', driverName: 'Ana', fee: 6 }, { orderId: 2, driverId: 'a', driverName: 'Ana', fee: 7 }],
        deliveryFeeCorrections: [{ orderId: 1, from: 6, to: 8 }, { orderId: 1, from: 8, to: 9 }]
    };
    assert.deepEqual(JSON.parse(JSON.stringify(context.corrected(session))), [{ name: 'Ana', count: 2, fee: 16 }]);
    assert.equal(session.deliveries[0].fee, 6);
});

test('real print routing sends removed and added items to their respective production sectors', async () => {
    const printed = [];
    const order = {
        id: 1, type: 'DELIVERY', at: Date.now(), editHistory: [{
            at: Date.now(), by: 'Caixa',
            before: { items: [{ name: 'Sopa', category: 'Cozinha', qty: 1, det: [] }] },
            after: { items: [{ name: 'Pizza', category: 'Pizzas', qty: 1, det: ['+ Queijo'] }] }
        }]
    };
    const context = {
        S: { orders: [order], menu: { ac: [] } }, window: {}, tkEnd: '',
        qzSettings: {
            categorySectors: { Cozinha: 'kitchen', Pizzas: 'pizza' },
            sectors: [{ id: 'kitchen', printerId: 'impressora-cozinha' }, { id: 'pizza', printerId: 'impressora-pizza' }],
            productionCopies: { DELIVERY: 1 }, layoutDensity: 'compact', options: {}
        },
        thermalBrandMarkup: async () => '', where: () => 'Delivery', esc: String, money: String,
        ensureQzConnected: async () => {}, setQzStatus() {},
        sendQzPrint: async (printer, markup) => printed.push({ printer, markup }),
        toast(message) { throw new Error(message); }, console
    };
    const routingStart = html.indexOf('        function printOrderType(');
    const routingEnd = html.indexOf('        async function savePrintAgentToken(', routingStart);
    const printingStart = html.indexOf('        async function thermalMarkup(');
    const printingEnd = html.indexOf('        async function printBothThermal(', printingStart);
    vm.runInNewContext(`${html.slice(routingStart, routingEnd)}\n${html.slice(printingStart, printingEnd)}\nthis.printChange = printDeliveryChange;`, context);
    assert.equal(await context.printChange(1, 0), true);
    assert.equal(printed.length, 2);
    assert.equal(printed[0].printer, 'impressora-cozinha');
    assert.match(printed[0].markup, /REMOVER \/ CANCELAR[\s\S]*Sopa/);
    assert.doesNotMatch(printed[0].markup, /ADICIONAR/);
    assert.equal(printed[1].printer, 'impressora-pizza');
    assert.match(printed[1].markup, /ADICIONAR[\s\S]*Pizza/);
    assert.match(printed[1].markup, /\+ Queijo/);
});
