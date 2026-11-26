const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const onlineMenuHtml = fs.readFileSync(path.join(__dirname, '..', 'cardapio online.html'), 'utf8');
const orderBridge = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'functions', 'order-bridge', 'index.ts'),
    'utf8'
);

function extractFunction(startMarker, endMarker, exportName, context) {
    const start = html.indexOf(startMarker);
    const end = html.indexOf(endMarker, start);
    assert.notEqual(start, -1, `Could not find ${exportName}`);
    assert.notEqual(end, -1, `Could not find the end of ${exportName}`);
    vm.runInNewContext(
        `${html.slice(start, end)}\nthis.${exportName} = ${exportName};`,
        context
    );
    return context[exportName];
}

function extractOnlineMenuFunction(startMarker, endMarker, exportName, context) {
    const start = onlineMenuHtml.indexOf(startMarker);
    const end = onlineMenuHtml.indexOf(endMarker, start);
    assert.notEqual(start, -1, `Could not find ${exportName}`);
    assert.notEqual(end, -1, `Could not find the end of ${exportName}`);
    vm.runInNewContext(
        `${onlineMenuHtml.slice(start, end)}\nthis.${exportName} = ${exportName};`,
        context
    );
    return context[exportName];
}

test('category routing lets operators explicitly exclude a category', () => {
    let saves = 0;
    const context = {
        qzSettings: { categorySectors: {}, sectors: [{ id: 'kitchen' }] },
        saveQzSettings() { saves++; },
        toast(message) { throw new Error(message); }
    };
    const updateCategorySector = extractFunction(
        '        function updateCategorySector(',
        '        function updateCopySetting(',
        'updateCategorySector',
        context
    );

    updateCategorySector('Bebidas', 'none');

    assert.equal(context.qzSettings.categorySectors.Bebidas, 'none');
    assert.equal(saves, 1);
    assert.match(html, /<option value="none".*?>Não imprimir<\/option>/);
});

test('production batches omit excluded categories and keep other routing', () => {
    const context = {
        qzSettings: {
            categorySectors: { Bebidas: 'none', Petiscos: 'preparation' },
            sectors: [{ id: 'kitchen' }, { id: 'preparation' }]
        }
    };
    const productionPrintBatches = extractFunction(
        '        function productionPrintBatches(',
        '        async function savePrintAgentToken(',
        'productionPrintBatches',
        context
    );

    const batches = productionPrintBatches({
        items: [
            { name: 'Refrigerante', category: 'Bebidas' },
            { name: 'Batata frita', category: 'Petiscos' },
            { name: 'Pizza', category: 'Pizzas' }
        ]
    });

    assert.deepEqual(
        JSON.parse(JSON.stringify(
            batches.map(batch => [batch.printSectorId, batch.items.map(item => item.name)])
        )),
        [['preparation', ['Batata frita']], ['kitchen', ['Pizza']]]
    );
});

test('automatic printing schedules an order only once per browser session', async () => {
    let printCount = 0;
    const context = {
        automaticPrintQueue: new Set(),
        qzSettings: { enabled: true, automatic: true },
        isPrintAgentConnected: () => true,
        printBothThermal: () => {
            printCount++;
            return Promise.resolve();
        },
        console,
        toast() {}
    };
    const scheduleAutomaticOrderPrint = extractFunction(
        '        function scheduleAutomaticOrderPrint(',
        '        function initSharedStateSync(',
        'scheduleAutomaticOrderPrint',
        context
    );
    const order = { id: 72501, printRequested: true };

    scheduleAutomaticOrderPrint(order);
    scheduleAutomaticOrderPrint(order);
    await Promise.resolve();

    assert.equal(printCount, 1);
});

test('accepted online orders print on the remote agent even when normal auto-print is off', async () => {
    let printCount = 0;
    const context = {
        automaticPrintQueue: new Set(),
        qzSettings: { enabled: true, automatic: false },
        isPrintAgentConnected: () => true,
        printBothThermal: () => {
            printCount++;
            return Promise.resolve();
        },
        console,
        toast() {}
    };
    const scheduleAutomaticOrderPrint = extractFunction(
        '        function scheduleAutomaticOrderPrint(',
        '        function initSharedStateSync(',
        'scheduleAutomaticOrderPrint',
        context
    );

    scheduleAutomaticOrderPrint({ id: 72502, printRequested: true, onlineOrderPrint: true });
    await Promise.resolve();

    assert.equal(printCount, 1);
});

test('new table and counter orders print only production; delivery and pickup also print cashier copies', async () => {
    const printed = [];
    const context = {
        printCopyCount: () => 1,
        printThermal: async (type, id) => { printed.push([id, type]); return true; },
        toast: message => { throw new Error(message); }
    };
    const printBothThermal = extractFunction(
        '        async function printBothThermal(',
        '        async function testConfiguredPrinter(',
        'printBothThermal',
        context
    );
    for (const order of [
        { id: 1, type: 'MESA' },
        { id: 2, type: 'BALCAO' },
        { id: 3, type: 'DELIVERY' },
        { id: 4, type: 'BALCAO', serviceType: 'RETIRADA' }
    ]) {
        assert.equal(await printBothThermal(order), true);
    }
    assert.deepEqual(printed, [
        [1, 'kitchen'], [2, 'kitchen'],
        [3, 'kitchen'], [3, 'caixa'],
        [4, 'kitchen'], [4, 'caixa']
    ]);
});

test('online pickup remains identified as pickup when imported into the POS', async () => {
    let imported;
    const context = {
        S: { orders: [], menu: { svc: 10 } },
        KEY: 'state',
        localStorage: { setItem() {} },
        supabaseClient: { from: () => ({ upsert: async () => ({ error: null }) }) },
        save: async () => true,
        sharedStateSaveCount: 0,
        shouldDelegateAcceptedOnlinePrint: () => false,
        formatBrazilPhone: value => value || '',
        finalize: order => { imported = order; return order; },
        callOrderBridge: async () => {}
    };
    const importOrder = extractFunction(
        '        async function importAcceptedOnlineOrder(',
        '        function switchTab(',
        'importAcceptedOnlineOrder',
        context
    );
    await importOrder({
        id: 'pickup-1',
        payload: { deliveryType: 'pickup', items: [{ name: 'Pizza', qty: 1, price: 20 }] }
    });
    assert.equal(imported.type, 'BALCAO');
    assert.equal(imported.serviceType, 'RETIRADA');
});

test('accepting an online order starts printing when the import confirms readiness', async () => {
    let resolveImport;
    let markImportStarted;
    let printStarted = false;
    const importStarted = new Promise(resolve => { markImportStarted = resolve; });
    const context = {
        onlinePendingOrderIds: new Set(['online-1']),
        canHandleOnlineOrders: () => true,
        callOrderBridge: async () => ({ order: { id: 'online-1' } }),
        syncOnlineOrderAlert() {},
        importAcceptedOnlineOrder: (_order, onOrderReady) => {
            return new Promise(resolve => {
                resolveImport = () => {
                    onOrderReady({ id: 72503, printRequested: false });
                    resolve({ id: 72503, printRequested: false });
                };
                markImportStarted();
            });
        },
        printBothThermal: () => {
            printStarted = true;
            return Promise.resolve(true);
        },
        toast() {},
        refreshOnlineOrders: async () => {}
    };
    const acceptOnlineOrder = extractFunction(
        '        async function acceptOnlineOrder(',
        '        async function rejectOnlineOrder(',
        'acceptOnlineOrder',
        context
    );

    const acceptance = acceptOnlineOrder('online-1');
    await importStarted;
    assert.equal(printStarted, false);
    assert.equal(typeof resolveImport, 'function');
    resolveImport();
    await acceptance;
    assert.equal(printStarted, true);
});

test('online order printing waits for shared persistence confirmation', async () => {
    let resolveSave;
    let orderReady = false;
    let orderMarkedImported = false;
    const context = {
        S: { orders: [{ id: 72504, onlineOrderId: 'online-2' }] },
        KEY: 'state',
        localStorage: { setItem() {} },
        supabaseClient: {},
        save: () => new Promise(resolve => { resolveSave = resolve; }),
        callOrderBridge: async action => {
            assert.equal(action, 'staff_imported');
            orderMarkedImported = true;
        }
    };
    const importAcceptedOnlineOrder = extractFunction(
        '        async function importAcceptedOnlineOrder(',
        '        function switchTab(',
        'importAcceptedOnlineOrder',
        context
    );

    const importing = importAcceptedOnlineOrder(
        { id: 'online-2', payload: {} },
        () => { orderReady = true; }
    );
    assert.equal(orderReady, false);
    assert.equal(orderMarkedImported, false);
    resolveSave(true);
    await importing;

    assert.equal(orderReady, true);
    assert.equal(orderMarkedImported, true);
});

test('table preview requested remotely is confirmed only after the printer reports success', async () => {
    const calls = [];
    const messages = [];
    const context = {
        isPrintAgentConnected: () => false,
        sharedPrintAgentId: () => 'cashier-1',
        callOrderBridge: async (action, data) => {
            calls.push([action, data]);
            return action === 'table_preview_create' ? { jobId: 'job-1' } : { status: 'printed' };
        },
        printAgentPresenceChannel: { send: async () => 'ok' },
        printAgentPresenceSubscribed: true,
        toast: message => messages.push(message),
        setTimeout: resolve => resolve(),
        console,
        Date
    };
    const printTablePreview = extractFunction(
        '        async function printTablePreview(',
        '        function initRealtimeOnlineOrders(',
        'printTablePreview',
        context
    );
    const bill = { id: 1, mesa: 2, accountPreview: true };

    assert.equal(await printTablePreview(bill), true);
    assert.equal(calls[0][0], 'table_preview_create');
    assert.equal(calls[0][1].bill, bill);
    assert.equal(calls[1][0], 'table_preview_status');
    assert.match(messages.at(-1), /enviada para a impressora/);
});

test('cashier processes one remote preview and reports printer failure', async () => {
    const calls = [];
    const context = {
        tablePreviewWorkerBusy: false,
        lastTablePreviewWorkerError: '',
        currentUser: { id: 1 },
        isPrintAgentConnected: () => true,
        PRINT_AGENT_PRESENCE_SOURCE_ID: 'cashier-1',
        callOrderBridge: async (action, data) => {
            calls.push([action, data]);
            return action === 'table_preview_claim' ? { job: { id: 'job-1', bill: { id: 9 } } } : {};
        },
        printThermal: async () => false,
        toast() {},
        console
    };
    const processJob = extractFunction(
        '        async function processTablePreviewPrintJob()',
        '        async function printTablePreview(',
        'processTablePreviewPrintJob',
        context
    );
    await processJob();
    assert.equal(calls[0][0], 'table_preview_claim');
    assert.equal(calls[1][0], 'table_preview_result');
    assert.equal(calls[1][1].printed, false);
    assert.equal(context.tablePreviewWorkerBusy, false);
});

test('cashier reuses a printed waiter preview only while the table remains unchanged', async () => {
    const shared = require('../mesa-conta-compartilhada.js');
    const orders = [
        { id: 1, type: 'MESA', mesa: 2, paid: false, status: 'PENDENTE', items: [{ name: 'Pizza', qty: 1, price: 50, det: [] }], sub: 50, svc: 5, total: 55 }
    ];
    const bill = { ...shared.createMesaBill(2, orders, null, 'Garçom'), waiterPreview: true };
    const previews = new Map();
    const calls = [];
    const messages = [];
    const elements = new Map();
    const context = {
        window: { GabryelleMesa: shared }, printedWaiterPreviews: previews,
        tablePreviewWorkerBusy: false, lastTablePreviewWorkerError: '',
        currentUser: { id: 1, name: 'Caixa' }, isPrintAgentConnected: () => true,
        PRINT_AGENT_PRESENCE_SOURCE_ID: 'caixa-1',
        callOrderBridge: async action => action === 'table_preview_claim' ? { job: { id: 'job-1', bill } } : {},
        printThermal: async () => true, toast: message => messages.push(message), console,
        isOrderOpen: order => !order.paid && order.status !== 'CANCELADO',
        pendingPaymentTarget: null,
        createMesaBill: (number, entries) => shared.createMesaBill(number, entries, null, 'Caixa'),
        printTablePreview: value => calls.push(value),
        money: String, PAYS: [], addPaymentLine() {}, updatePaymentPreview() {},
        $: id => {
            if (!elements.has(id)) elements.set(id, { classList: { toggle() {}, add() {}, remove() {} }, value: '', textContent: '', innerHTML: '', checked: false });
            return elements.get(id);
        }
    };
    const processJob = extractFunction(
        '        async function processTablePreviewPrintJob()',
        '        async function printTablePreview(',
        'processTablePreviewPrintJob',
        context
    );
    const openPayment = extractFunction(
        '        function openPaymentModal(',
        '        function addPaymentLine(',
        'openPaymentModal',
        context
    );
    await processJob();
    assert.match(messages.at(-1), /mesa 2.*pagamento/);
    openPayment(orders, 2);
    assert.equal(calls.length, 0);
    await processJob();
    orders[0].items[0].qty = 2;
    orders[0].sub = 100;
    orders[0].svc = 10;
    orders[0].total = 110;
    openPayment(orders, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].total, 110);
    const adjustment = shared.createMesaBill(2, orders, { removeService: true, discounts: [0], totalCents: 10000 });
    assert.equal(adjustment.svc, 0);
    assert.equal(adjustment.total, 100);
});

test('opening table payment refreshes shared orders and refuses an unconfirmed state', async () => {
    let syncOk = false;
    let opened = null;
    const messages = [];
    const orders = [{ id: 8, type: 'MESA', total: 55 }];
    const context = {
        supabaseClient: {},
        syncSharedState: async () => syncOk,
        caixaAberto: () => true,
        mesaOrders: () => orders,
        openPaymentModal: (...args) => { opened = args; },
        toast: message => messages.push(message)
    };
    const closeTable = extractFunction(
        '        async function fecharMesa(',
        '        // ---------- Caixa ----------',
        'fecharMesa',
        context
    );
    await closeTable(2);
    assert.equal(opened, null);
    assert.match(messages[0], /Não foi possível atualizar/);
    syncOk = true;
    await closeTable(2);
    assert.equal(opened[0], orders);
    assert.equal(opened[1], 2);
});

test('table preview without a connected printer is reported instead of pretending success', async () => {
    const messages = [];
    const context = {
        isPrintAgentConnected: () => false,
        sharedPrintAgentId: () => null,
        printAgentPresenceChannel: null,
        printAgentPresenceSubscribed: false,
        toast: message => messages.push(message)
    };
    const printTablePreview = extractFunction(
        '        async function printTablePreview(',
        '        function initRealtimeOnlineOrders(',
        'printTablePreview',
        context
    );
    assert.equal(await printTablePreview({ id: 1 }), false);
    assert.match(messages[0], /não impressa/);
});

test('table and delivery order numbers are prominent on their receipts', async () => {
    const context = {
        thermalBrandMarkup: async () => '',
        where: order => order.type === 'DELIVERY' ? 'Delivery' : `Mesa ${order.mesa}`,
        esc: value => String(value),
        money: value => String(value),
        S: { menu: { ac: [] } },
        qzSettings: {
            layoutDensity: 'compact',
            options: {},
            kitchenMessage: '',
            standardMessage: '',
            tableMessage: ''
        },
        tkEnd: '',
        window: {}
    };
    const thermalMarkup = extractFunction(
        '        async function thermalMarkup(',
        '        async function printThermal(',
        'thermalMarkup',
        context
    );
    const tableOrder = {
        id: 8, type: 'MESA', mesa: 12, at: Date.now(),
        items: [{ name: 'Pizza', qty: 1, price: 30, det: [] }], total: 30
    };

    for (const [type, order] of [
        ['kitchen', tableOrder],
        ['caixa', { ...tableOrder, accountPreview: true }]
    ]) {
        const markup = await thermalMarkup(type, order);
        assert.match(markup, /<div class="tk-c tk-table-number">MESA: 12<\/div>/);
        assert.match(markup, /PEDIDO: #8/);
    }
    for (const type of ['kitchen', 'caixa']) {
        const delivery = await thermalMarkup(type, { ...tableOrder, type: 'DELIVERY' });
        assert.doesNotMatch(delivery, /tk-table-number/);
        assert.match(delivery, /<div class="tk-c tk-order-number">PEDIDO: #8<\/div>/);
        assert.match(delivery, /<span>DELIVERY<\/span>/);
    }
    const adjusted = await thermalMarkup('caixa', {
        ...tableOrder, accountPreview: true, removedService: 3, discount: 5, total: 25
    });

    assert.match(adjusted, /Serviço removido/);
    assert.match(adjusted, /Desconto/);
    assert.match(adjusted, /TOTAL DA CONTA<\/span><span>25<\/span>/);
    const optionalService = await thermalMarkup('caixa', {
        ...tableOrder, accountPreview: true, sub: 30, svc: 3, total: 33
    });
    assert.match(optionalService, /Serviço \(opcional\)<\/span><span>3<\/span>/);
    assert.match(optionalService, /Total sem serviço<\/span><span>30<\/span>/);
    assert.match(optionalService, /Serviço opcional: informe sua escolha no caixa/);
    assert.match(optionalService, /1x Pizza<\/span><span>30<\/span>/);
});

test('delivery change receipt clearly distinguishes removed and added items', async () => {
    const context = {
        thermalBrandMarkup: async () => '', where: () => 'Delivery',
        esc: value => String(value), money: String, S: { menu: { ac: [] } },
        qzSettings: { layoutDensity: 'compact', options: {} }, tkEnd: '', window: {}
    };
    const thermalMarkup = extractFunction(
        '        async function thermalMarkup(',
        '        async function printThermal(',
        'thermalMarkup',
        context
    );
    const markup = await thermalMarkup('kitchen', {
        id: 8, type: 'DELIVERY', at: Date.now(),
        items: [
            { name: 'Pizza Média', qty: 1, det: ['Queijo'], editAction: 'REMOVER / CANCELAR' },
            { name: 'Pizza Grande', qty: 1, det: ['Queijo'], editAction: 'ADICIONAR' }
        ],
        editNotice: { at: Date.now(), by: 'Caixa', before: { end: 'Rua 1' }, after: { end: 'Rua 2' } }
    });
    assert.match(markup, /ALTERAÇÃO DE PEDIDO/);
    assert.match(markup, /PEDIDO: #8/);
    assert.match(markup, /REMOVER \/ CANCELAR[\s\S]*Pizza Média/);
    assert.match(markup, /ADICIONAR[\s\S]*Pizza Grande/);
    assert.match(markup, /Endereço: Rua 2/);
    assert.match(markup, /NÃO REFAZER ITENS SEM ALTERAÇÃO/);
});

test('table adjustments remove service and distribute discounts in cents across orders', () => {
    const calculate = extractFunction(
        '        function calculateTableAdjustments(',
        '        function createMesaBill(',
        'calculateTableAdjustments',
        {}
    );
    const orders = [{ total: 55, svc: 5 }, { total: 22, svc: 2 }];
    const result = calculate(orders, '50.01', true);
    assert.equal(result.totalCents, 1999);
    assert.deepEqual(Array.from(result.discounts), [5000, 1]);
    assert.match(calculate(orders, '70.01', true).error, /ultrapassar/);
    assert.match(calculate(orders, '-1', false).error, /válido/);
    assert.match(calculate(orders, '1.001', false).error, /válido/);
    assert.equal(calculate(orders, '70', true).totalCents, 0);
});

test('closing a table persists adjustments and payment allocations including a fully discounted order', async () => {
    const orders = [
        { id: 1, type: 'MESA', mesa: 2, total: 55, svc: 5, sub: 50, items: [] },
        { id: 2, type: 'MESA', mesa: 2, total: 22, svc: 2, sub: 20, items: [] }
    ];
    const context = {
        S: { orders, caixa: { movs: [] } },
        PAYS: ['Dinheiro', 'PIX'],
        orderCancellationPending: false,
        paymentSaving: false,
        supabaseClient: null,
        save: async () => true,
        pendingPaymentTarget: { mesaNumber: 2, orderIds: ['1', '2'] },
        caixaAberto: () => true,
        mesaOrders: () => orders,
        isOrderOpen: order => !order.paid,
        where: () => 'Mesa 2',
        money: value => String(value),
        closePaymentModal() {},
        renderAll() {},
        toast() {},
        $: id => {
            if (id === 'table-discount') return { value: '50' };
            if (id === 'table-remove-service') return { checked: true };
            if (id === 'payment-lines') return {
                querySelectorAll: () => [{
                    querySelector: selector => ({ value: selector === 'select' ? 'PIX' : '20' })
                }]
            };
            throw new Error(`Unexpected element ${id}`);
        }
    };
    extractFunction('        function calculateTableAdjustments(', '        function createMesaBill(', 'calculateTableAdjustments', context);
    extractFunction('        function calculatePaymentAmounts(', '        function readPaymentDraft(', 'calculatePaymentAmounts', context);
    extractFunction('        function readPaymentDraft(', '        function updateTablePaymentAdjustments(', 'readPaymentDraft', context);
    const confirm = extractFunction('        function confirmOrderPayment(', '        function cancelOrder(', 'confirmOrderPayment', context);
    await confirm();
    assert.equal(orders[0].total, 0);
    assert.equal(orders[0].discount, 50);
    assert.equal(orders[0].removedService, 5);
    assert.equal(orders[1].total, 20);
    assert.equal(orders[1].svc, 0);
    assert.equal(context.S.caixa.movs.reduce((sum, movement) => sum + movement.v, 0), 20);
    assert.equal(context.S.caixa.movs.length, 2);
});

test('a table can be fully discounted and closed without a payment', async () => {
    const orders = [{ id: 1, type: 'MESA', mesa: 2, total: 22, svc: 2, items: [] }];
    const context = {
        S: { orders, caixa: { movs: [] } },
        PAYS: ['Dinheiro'],
        orderCancellationPending: false,
        paymentSaving: false,
        supabaseClient: null,
        save: async () => true,
        pendingPaymentTarget: { mesaNumber: 2, orderIds: ['1'] },
        caixaAberto: () => true,
        mesaOrders: () => orders,
        isOrderOpen: order => !order.paid,
        where: () => 'Mesa 2',
        money: value => String(value),
        closePaymentModal() {},
        renderAll() {},
        toast() {},
        $: id => {
            if (id === 'table-discount') return { value: '20' };
            if (id === 'table-remove-service') return { checked: true };
            if (id === 'payment-lines') return {
                querySelectorAll: () => [{
                    querySelector: selector => ({ value: selector === 'select' ? 'Dinheiro' : '0' })
                }]
            };
            throw new Error(`Unexpected element ${id}`);
        }
    };
    extractFunction('        function calculateTableAdjustments(', '        function createMesaBill(', 'calculateTableAdjustments', context);
    extractFunction('        function calculatePaymentAmounts(', '        function readPaymentDraft(', 'calculatePaymentAmounts', context);
    extractFunction('        function readPaymentDraft(', '        function updateTablePaymentAdjustments(', 'readPaymentDraft', context);
    const confirm = extractFunction('        function confirmOrderPayment(', '        function cancelOrder(', 'confirmOrderPayment', context);
    await confirm();
    assert.equal(orders[0].paid, true);
    assert.equal(orders[0].total, 0);
    assert.equal(orders[0].discount, 20);
    assert.equal(context.S.caixa.movs[0].v, 0);
});

test('table preview asks for printer presence and waits for a response before sending', async () => {
    let targetAvailable = false;
    const sentEvents = [];
    const calls = [];
    const context = {
        isPrintAgentConnected: () => false,
        sharedPrintAgentId: () => targetAvailable ? 'cashier-1' : null,
        printAgentPresenceChannel: {
            send: async event => {
                sentEvents.push(event.event);
                if (event.event === 'status-request') targetAvailable = true;
                return 'ok';
            }
        },
        printAgentPresenceSubscribed: true,
        callOrderBridge: async action => {
            calls.push(action);
            return action === 'table_preview_create' ? { jobId: 'job-1' } : { status: 'printed' };
        },
        setTimeout: resolve => resolve(),
        toast() {},
        console,
        Date
    };
    const printTablePreview = extractFunction(
        '        async function printTablePreview(',
        '        function initRealtimeOnlineOrders(',
        'printTablePreview',
        context
    );
    assert.equal(await printTablePreview({ id: 1 }), true);
    assert.deepEqual(sentEvents, ['status-request', 'table-preview']);
    assert.deepEqual(calls, ['table_preview_create', 'table_preview_status']);
});

test('printer presence uses receive time to tolerate devices with different clocks', () => {
    const handlers = {};
    const channel = {
        on(_type, filter, callback) { handlers[filter.event] = callback; return this; },
        subscribe() { return this; }
    };
    const context = {
        supabaseClient: { channel: () => channel },
        printAgentPresenceChannel: null,
        printAgentPresenceSources: new Map(),
        PRINT_AGENT_PRESENCE_SOURCE_ID: 'mobile',
        isPrintAgentConnected: () => true,
        publishPrintAgentPresence() { context.responded = true; },
        updateQzConnectionIndicator() {},
        Date
    };
    const init = extractFunction(
        '        function initPrintAgentPresence()',
        '        async function publishPrintAgentPresence(',
        'initPrintAgentPresence',
        context
    );
    init();
    handlers.status({ payload: { sourceId: 'cashier', connected: true, sentAt: 1 } });
    assert.ok(Date.now() - context.printAgentPresenceSources.get('cashier') < 1000);
    handlers['status-request']();
    assert.equal(context.responded, true);
});

test('pizza menu shows medium, large and family sizes before flavor selection', () => {
    const elements = {
        'menu-search': { value: '' },
        'menu-cats': { innerHTML: '' },
        'menu-grid': { innerHTML: '' }
    };
    const context = {
        $: id => elements[id],
        curCat: 'Pizzas',
        S: { menu: { cats: {}, pt: [10, 20, 30, 40], pd: [10, 20, 30, 40] } },
        SIZES: ['Pequena', 'Média', 'Grande', 'Família'],
        menuItems: () => [],
        promotionPrice: (_key, price) => price,
        money: price => `R$ ${price}`,
        esc: value => value
    };
    extractFunction('        function renderMenu(', '        function pick(', 'renderMenu', context)();

    assert.match(elements['menu-grid'].innerHTML, /Pizza Média/);
    assert.match(elements['menu-grid'].innerHTML, /Pizza Grande/);
    assert.match(elements['menu-grid'].innerHTML, /Pizza Família/);
    assert.doesNotMatch(elements['menu-grid'].innerHTML, /Pizza Calabresa|Pizza Mussarela/);
    assert.match(elements['menu-grid'].innerHTML, /openPizza\('',0,1\)/);
    assert.match(elements['menu-grid'].innerHTML, /openPizza\('',0,2\)/);
    assert.match(elements['menu-grid'].innerHTML, /openPizza\('',0,3\)/);
});

test('selecting a pizza size opens the flavor step with that size selected', () => {
    const context = {
        pm: null,
        S: { menu: { mf: [4, 4, 4, 4] } },
        renderPM() {},
        $: () => ({ classList: { remove() {}, add() {} } })
    };
    const openPizza = extractFunction(
        '        function openPizza(',
        '        function closePizza(',
        'openPizza',
        context
    );

    openPizza('', 0, 3);

    assert.equal(context.pm.s, 3);
    assert.equal(context.pm.sizeSelected, true);
    assert.deepEqual(JSON.parse(JSON.stringify(context.pm.fl)), []);
});

test('administrator, manager and cashier PINs require eight digits; other roles retain four', () => {
    const pinLengthForRole = extractFunction(
        '        function pinLengthForRole(',
        '        function updateUserPinRequirements(',
        'pinLengthForRole',
        {}
    );

    for (const role of ['ADMIN', 'GERENTE', 'CAIXA']) {
        assert.equal(pinLengthForRole(role), 8);
    }
    assert.equal(pinLengthForRole('GARCOM'), 4);
    assert.match(html, /id="pin-input"[^>]*maxlength="8"/);
    assert.match(html, /Código PIN \(\\?\$\{length\} dígitos\)/);
});

test('login accepts the saved PIN length so existing accounts can migrate', () => {
    const input = { value: '12345678' };
    const modal = { classList: { add() {} } };
    const context = {
        users: [{ id: 1, role: 'ADMIN', pin: '12345678', active: true }],
        currentUser: null,
        pinLengthForRole: role => ['ADMIN', 'GERENTE', 'CAIXA'].includes(role) ? 8 : 4,
        toast() {},
        updateRolePermissions() {},
        renderUsersTable() {},
        renderOrdersList() {},
        document: {
            getElementById(id) {
                if (id === 'login-user-select') return { value: '1' };
                if (id === 'pin-input') return input;
                if (id === 'login-modal') return modal;
                throw new Error(`Unexpected element ${id}`);
            }
        }
    };
    const submitLogin = extractFunction(
        '        function submitLogin(',
        '        function toggleFullscreen(',
        'submitLogin',
        context
    );

    submitLogin();
    assert.equal(context.currentUser.role, 'ADMIN');
    assert.equal(input.value, '12345678');

    context.users[0].pin = '1234';
    input.value = '1234';
    submitLogin();
    assert.equal(context.currentUser.role, 'ADMIN');
});

test('pizza flavor filter matches names and descriptions without case or accent sensitivity', () => {
    const context = {};
    const pizzaFlavorMatches = extractFunction(
        '        function pizzaFlavorMatches(',
        '        function renderPMFlavors(',
        'pizzaFlavorMatches',
        context
    );

    assert.equal(pizzaFlavorMatches(['Calabresa', 'Queijo e cebola'], 'CALAB'), true);
    assert.equal(pizzaFlavorMatches(['Quatro Queijos', 'Mussarela e gorgonzola'], 'gorgonzola'), true);
    assert.equal(pizzaFlavorMatches(['Frango com Catupiry', 'Mussarela e frango'], 'catupíry'), true);
    assert.equal(pizzaFlavorMatches(['Calabresa', 'Queijo e cebola'], 'abacaxi'), false);
});

test('filtering pizza flavors keeps selected flavors available and shows an empty state', () => {
    const flavorsList = { innerHTML: '' };
    const context = {
        pm: { d: 0, fl: ['Calabresa'], flavorSearch: 'calab' },
        DOCE: [],
        PZ: [
            ['Calabresa', 'Mussarela e calabresa'],
            ['Frango', 'Mussarela e frango']
        ],
        $: id => id === 'pm-flavor-list' ? flavorsList : null
    };
    extractFunction(
        '        function pizzaFlavorMatches(',
        '        function renderPMFlavors(',
        'pizzaFlavorMatches',
        context
    );
    const renderPMFlavors = extractFunction(
        '        function renderPMFlavors(',
        '        function renderPM(',
        'renderPMFlavors',
        context
    );

    renderPMFlavors();
    assert.match(flavorsList.innerHTML, /Calabresa/);
    assert.match(flavorsList.innerHTML, /checked/);
    assert.doesNotMatch(flavorsList.innerHTML, /Frango/);

    context.pm.flavorSearch = 'inexistente';
    renderPMFlavors();
    assert.match(flavorsList.innerHTML, /Nenhum sabor encontrado/);
});

test('pizza builder offers savory and sweet flavors together and keeps selections when changing type', () => {
    const flavorsList = { innerHTML: '' };
    const context = {
        pm: { d: 0, s: 2, fl: ['Calabresa'], flavorSearch: '' },
        S: { menu: { mf: [4, 4, 2, 4] } },
        PZ: [['Calabresa', 'Queijo e calabresa']],
        DOCE: [['Brigadeiro', 'Chocolate']],
        SIZES: ['Pequena', 'Média', 'Grande', 'Família'],
        renderPM() {},
        toast() {},
        $: () => flavorsList
    };
    extractFunction('        function pizzaFlavorMatches(', '        function renderPMFlavors(', 'pizzaFlavorMatches', context);
    const renderPMFlavors = extractFunction('        function renderPMFlavors(', '        function renderPM()', 'renderPMFlavors', context);
    const pmFl = extractFunction('        function pmFl(', '        function pmAc(', 'pmFl', context);
    const pmSet = extractFunction('        function pmSet(', '        function pmFl(', 'pmSet', context);

    renderPMFlavors();
    assert.match(flavorsList.innerHTML, /Calabresa.*Salgada/);
    assert.match(flavorsList.innerHTML, /Brigadeiro.*Doce/);
    pmFl('Brigadeiro');
    pmSet('d', 1);
    assert.deepEqual(context.pm.fl, ['Calabresa', 'Brigadeiro']);
    context.pm.flavorSearch = 'brig';
    renderPMFlavors();
    assert.match(flavorsList.innerHTML, /Brigadeiro.*Doce/);
    assert.doesNotMatch(flavorsList.innerHTML, /Calabresa/);
});

test('mixed pizza uses the greater effective price and requires both prices to be configured', () => {
    const added = [];
    const messages = [];
    const context = {
        pm: { d: 0, s: 2, fl: ['Calabresa', 'Brigadeiro'], ac: [0], q: 1, o: '' },
        S: { menu: { pt: [0, 0, 70, 0], pd: [0, 0, 80, 0], ac: [['Borda', 5]] } },
        PZ: [['Calabresa', 'Queijo e calabresa']],
        DOCE: [['Brigadeiro', 'Chocolate']],
        SIZES: ['Pequena', 'Média', 'Grande', 'Família'],
        promotionPrice: (key, price) => key === 'pizza:pd:2' ? price - 20 : price,
        addCart: order => added.push(order),
        toast: message => messages.push(message),
        closePizza() {}
    };
    const pmPrice = extractFunction('        function isMixedPizza()', '        function pmSet(', 'pmPrice', context);
    const addPizza = extractFunction('        function addPizza()', '        // ---------- Carrinho ----------', 'addPizza', context);

    assert.equal(pmPrice(), 75);
    addPizza();
    assert.equal(added[0].price, 75);
    assert.deepEqual(Array.from(added[0].det), ['Calabresa', 'Brigadeiro', '+ Borda']);
    context.S.menu.pd[2] = 0;
    addPizza();
    assert.equal(added.length, 1);
    assert.match(messages[0], /Configure os preços/);
    context.S.menu.pd[2] = 80;
    context.pm.fl = ['Brigadeiro'];
    assert.equal(pmPrice(), 65);
});

test('online checkout payload matches the order bridge contract', () => {
    const buildOnlineOrderPayload = extractOnlineMenuFunction(
        '        function roundOnlineMoney(',
        '        function createOnlineOrderIdentity(',
        'buildOnlineOrderPayload',
        {}
    );
    const payload = buildOnlineOrderPayload({
        customerName: 'Cliente',
        customerPhone: '(77) 99111-2222',
        deliveryType: 'delivery',
        address: 'Rua 1, 10',
        complement: 'Casa azul',
        deliveryFee: 5,
        payment: 'Pix'
    }, [
        { name: 'Pizza Família', size: 'Família', qty: 1, price: 65, flavors: ['Calabresa', 'Atum'] },
        { name: 'Refrigerante Lata', size: 'Padrão', qty: 2, price: 6 }
    ]);

    assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
        customer: { name: 'Cliente', phone: '(77) 99111-2222' },
        items: [
            { name: 'Pizza Família', size: 'Família', qty: 1, price: 65, flavors: ['Calabresa', 'Atum'] },
            { name: 'Refrigerante Lata', size: 'Padrão', qty: 2, price: 6, flavors: [] }
        ],
        deliveryType: 'delivery',
        address: 'Rua 1, 10',
        complement: 'Casa azul',
        subtotal: 77,
        deliveryFee: 5,
        total: 82,
        payment: 'Pix'
    });
});

test('online menu navigation uses the requested restaurant name', () => {
    const header = onlineMenuHtml.slice(
        onlineMenuHtml.indexOf('<!-- LOGO -->'),
        onlineMenuHtml.indexOf('<!-- DESKTOP NAV -->')
    );
    assert.match(header, /Restaurante e Pizzaria Gabryelle/);
    assert.doesNotMatch(header, /GABRYELLE\s*<span[^>]*>PRIME<\/span>/);
});

test('checkout fields use a 16px minimum font size to prevent mobile focus zoom', () => {
    assert.match(onlineMenuHtml, /#cartModal input,\s*#cartModal select\s*\{\s*font-size:\s*16px;/);
});

test('online pizza size opens an empty flavor selection with the correct maximum', () => {
    const title = { textContent: '' };
    const modal = { classList: { remove() {}, add() {} } };
    const context = {
        pizzaFlavorSelection: null,
        getAvailablePizzaFlavors: () => [{ id: 1, name: 'Calabresa', desc: '', category: 'tradicional' }],
        document: {
            getElementById(id) {
                if (id === 'pizzaFlavorModal') return modal;
                if (id === 'pizzaFlavorTitle') return title;
                throw new Error(`Unexpected element ${id}`);
            }
        },
        renderPizzaFlavorOptions() {}
    };
    const openPizzaFlavorPicker = extractOnlineMenuFunction(
        '        function openPizzaFlavorPicker(',
        '        function renderPizzaFlavorOptions(',
        'openPizzaFlavorPicker',
        context
    );

    for (const [size, maxFlavors] of [['Média', 2], ['Grande', 3], ['Família', 4]]) {
        openPizzaFlavorPicker(size, 65);
        assert.equal(context.pizzaFlavorSelection.size, size);
        assert.equal(context.pizzaFlavorSelection.maxFlavors, maxFlavors);
        assert.equal(context.pizzaFlavorSelection.selectedIds.size, 0);
    }
});

test('online menu shows pizza sizes first and opens the flavor menu only after size selection', () => {
    assert.match(onlineMenuHtml, /id="menuGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"/);
    const elements = {
        searchInput: { value: '' },
        menuGrid: { innerHTML: '' },
        pizzaFlavorModal: { classList: { remove() {}, add() {} } },
        pizzaFlavorTitle: { textContent: '' },
        pizzaFlavorHint: { textContent: '' },
        pizzaFlavorOptions: { innerHTML: '' },
        pizzaFlavorConfirm: { disabled: false, textContent: '' }
    };
    const context = {
        MENU_DATA: [
            { id: 1, name: 'Calabresa', category: 'tradicional', desc: 'Calabresa e cebola.' },
            { id: 2, name: 'Frango com Catupiry', category: 'tradicional', desc: 'Frango e catupiry.' },
            { id: 101, name: 'Batata Frita', category: 'petisco', desc: 'Porção crocante.', fixedPrice: 25 },
            { id: 201, name: 'Refrigerante Lata', category: 'bebida', desc: '350ml.', fixedPrice: 6 }
        ],
        currentCategory: 'all',
        isPromoDayActive: false,
        pizzaFlavorSelection: null,
        document: { getElementById: id => elements[id] }
    };
    context.getAvailablePizzaFlavors = extractOnlineMenuFunction(
        '        function getAvailablePizzaFlavors(',
        '        // RENDER COMPLETE MENU',
        'getAvailablePizzaFlavors',
        context
    );
    context.renderPizzaFlavorOptions = extractOnlineMenuFunction(
        '        function renderPizzaFlavorOptions(',
        '        function togglePizzaFlavor(',
        'renderPizzaFlavorOptions',
        context
    );
    const renderMenu = extractOnlineMenuFunction(
        '        function renderMenu(',
        '        // FILTER CATEGORY',
        'renderMenu',
        context
    );
    const openPizzaFlavorPicker = extractOnlineMenuFunction(
        '        function openPizzaFlavorPicker(',
        '        function renderPizzaFlavorOptions(',
        'openPizzaFlavorPicker',
        context
    );

    renderMenu();
    assert.match(elements.menuGrid.innerHTML, /Pizza Média/);
    assert.match(elements.menuGrid.innerHTML, /Pizza Grande/);
    assert.match(elements.menuGrid.innerHTML, /Pizza Família/);
    assert.doesNotMatch(elements.menuGrid.innerHTML, /Calabresa|Frango com Catupiry/);
    assert.match(elements.menuGrid.innerHTML, /Batata Frita/);
    assert.match(elements.menuGrid.innerHTML, /Refrigerante Lata/);
    assert.doesNotMatch(elements.menuGrid.innerHTML, /<img\b/);
    assert.match(elements.menuGrid.innerHTML, /R\$ 25\.00/);
    assert.match(elements.menuGrid.innerHTML, /Adicionar/);

    openPizzaFlavorPicker('Média', 43);
    assert.match(elements.pizzaFlavorTitle.textContent, /Pizza Média/);
    assert.match(elements.pizzaFlavorOptions.innerHTML, /Calabresa/);
    assert.match(elements.pizzaFlavorOptions.innerHTML, /Frango com Catupiry/);
    assert.equal(context.pizzaFlavorSelection.selectedIds.size, 0);
});

test('popular menu flavors are rendered as compact text cards without product images', () => {
    const popularGrid = { innerHTML: '' };
    const context = {
        MENU_DATA: [
            { id: 1, name: 'Calabresa', desc: 'Calabresa e cebola.', popular: true },
            { id: 2, name: 'Frango', desc: 'Frango e catupiry.', popular: true }
        ],
        document: { getElementById: () => popularGrid }
    };
    const renderPopularFlavors = extractOnlineMenuFunction(
        '        function renderPopularFlavors(',
        '        function getAvailablePizzaFlavors(',
        'renderPopularFlavors',
        context
    );

    renderPopularFlavors();
    assert.match(popularGrid.innerHTML, /Calabresa/);
    assert.match(popularGrid.innerHTML, /Frango/);
    assert.doesNotMatch(popularGrid.innerHTML, /<img\b/);
});

test('featured pizza presentation uses the text-card style without a product photo', () => {
    const heroStart = onlineMenuHtml.indexOf('<!-- HERO IMAGE / FEATURED DISPLAY -->');
    const heroEnd = onlineMenuHtml.indexOf('<!-- PROMO BANNER SPECIAL SECTION -->', heroStart);
    assert.notEqual(heroStart, -1);
    assert.notEqual(heroEnd, -1);
    const featuredPizza = onlineMenuHtml.slice(heroStart, heroEnd);

    assert.match(featuredPizza, /Pizza Gabryelle Prime/);
    assert.doesNotMatch(featuredPizza, /<img\b/);
});

test('online pizza flavor selection cannot exceed its limit and allows fewer flavors', () => {
    const context = {
        pizzaFlavorSelection: { size: 'Família', price: 65, maxFlavors: 4, selectedIds: new Set() },
        renderPizzaFlavorOptions() {}
    };
    const togglePizzaFlavor = extractOnlineMenuFunction(
        '        function togglePizzaFlavor(',
        '        function closePizzaFlavorPicker(',
        'togglePizzaFlavor',
        context
    );
    for (const id of [1, 2, 3, 4, 5]) togglePizzaFlavor(id);

    assert.deepEqual([...context.pizzaFlavorSelection.selectedIds], [1, 2, 3, 4]);
    context.pizzaFlavorSelection = { size: 'Média', price: 43, maxFlavors: 2, selectedIds: new Set([1]) };
    togglePizzaFlavor(2);
    togglePizzaFlavor(3);
    assert.deepEqual([...context.pizzaFlavorSelection.selectedIds], [1, 2]);
});

test('online pizza is added with exactly the selected flavors, even below the limit', () => {
    const context = {
        pizzaFlavorSelection: {
            size: 'Grande',
            price: 55,
            maxFlavors: 3,
            selectedIds: new Set([2])
        },
        MENU_DATA: [
            { id: 1, name: 'Calabresa', category: 'tradicional' },
            { id: 2, name: 'Frango com Catupiry', category: 'tradicional' },
            { id: 3, name: 'Bebida', category: 'bebida' }
        ],
        cart: [],
        closePizzaFlavorPicker() {},
        updateCartUI() {},
        showNotification() {},
        Date,
        Math
    };
    const confirmPizzaFlavors = extractOnlineMenuFunction(
        '        function confirmPizzaFlavors(',
        '        function updateCartQuantity(',
        'confirmPizzaFlavors',
        context
    );
    confirmPizzaFlavors();

    assert.equal(context.cart.length, 1);
    assert.equal(context.cart[0].size, 'Grande');
    assert.deepEqual(JSON.parse(JSON.stringify(context.cart[0].flavors)), ['Frango com Catupiry']);
});

test('online checkout submits directly to the order bridge and tracks status', () => {
    assert.match(onlineMenuHtml, /action:\s*'submit_order'/);
    assert.match(onlineMenuHtml, /action:\s*'order_status'/);
    const checkoutStart = onlineMenuHtml.indexOf('        async function finishOnlineOrder(');
    const checkoutEnd = onlineMenuHtml.indexOf('        // CHECK DAY OF WEEK', checkoutStart);
    assert.notEqual(checkoutStart, -1);
    assert.notEqual(checkoutEnd, -1);
    assert.doesNotMatch(onlineMenuHtml.slice(checkoutStart, checkoutEnd), /wa\.me/);
});

test('online order retries reuse the same idempotency credentials', async () => {
    const calls = [];
    const context = {
        ORDER_BRIDGE_URL: 'https://example.test/order-bridge',
        ORDER_BRIDGE_API_KEY: 'public-key',
        pendingOnlineSubmission: {
            requestId: 'b17e59e1-9c58-4e16-8a4b-64652a522480',
            trackingToken: 'a'.repeat(64),
            payload: { customer: { name: 'Cliente' } }
        },
        fetch: async (url, options) => {
            calls.push({ url, options, body: JSON.parse(options.body) });
            return { ok: true, json: async () => ({ order: { id: 'order-1' } }) };
        }
    };
    const sendOnlineOrderRequest = extractOnlineMenuFunction(
        '        async function sendOnlineOrderRequest(',
        '        function saveOnlineOrderTracking(',
        'sendOnlineOrderRequest',
        context
    );

    await sendOnlineOrderRequest();
    await sendOnlineOrderRequest();

    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.requestId, calls[1].body.requestId);
    assert.equal(calls[0].body.trackingToken, calls[1].body.trackingToken);
    assert.equal(calls[0].body.action, 'submit_order');
});

test('accepted online orders delegate printing only when the agent is remote', () => {
    const context = {
        isPrintAgentConnected: () => false,
        isSharedPrintAgentOnline: () => true
    };
    const shouldDelegateAcceptedOnlinePrint = extractFunction(
        '        function shouldDelegateAcceptedOnlinePrint(',
        '        async function callOrderBridge(',
        'shouldDelegateAcceptedOnlinePrint',
        context
    );

    assert.equal(shouldDelegateAcceptedOnlinePrint(), true);
    context.isPrintAgentConnected = () => true;
    assert.equal(shouldDelegateAcceptedOnlinePrint(), false);
});

test('online pending orders render even when importing an accepted order fails', async () => {
    let modalHidden = true;
    let renderedOrders = [];
    const elements = {
        'online-orders-modal': {
            classList: {
                contains: value => value === 'hidden' && modalHidden
            }
        },
        'online-orders-count': { textContent: '0' },
        'online-orders-status': { classList: { toggle() {} }, textContent: '' }
    };
    const context = {
        onlineOrdersLoading: false,
        onlineOrdersRefreshPending: false,
        onlineSeenPending: new Set(),
        onlinePendingOrderIds: new Set(),
        canHandleOnlineOrders: () => true,
        callOrderBridge: async () => ({
            orders: [
                { id: 'pending-1', status: 'pending' },
                { id: 'accepted-1', status: 'accepted', pos_imported: false }
            ]
        }),
        syncOnlineOrderAlert() {},
        openOnlineOrdersModal() { modalHidden = false; },
        renderOnlineOrderQueue(orders) { renderedOrders = orders; },
        importAcceptedOnlineOrder: async () => {
            throw new Error('Falha ao importar pedido aceito');
        },
        $(id) { return elements[id]; },
        toast() {},
        console: { error() {} }
    };
    const refreshOnlineOrders = extractFunction(
        '        async function refreshOnlineOrders()',
        '        function playOnlineOrderAlert()',
        'refreshOnlineOrders',
        context
    );

    await refreshOnlineOrders();

    assert.equal(modalHidden, false);
    assert.equal(elements['online-orders-count'].textContent, '1');
    assert.deepEqual(JSON.parse(JSON.stringify(renderedOrders.map(order => order.id))), ['pending-1']);
    assert.match(elements['online-orders-status'].textContent, /Falha ao atualizar pedidos online/);
});

test('online order refresh repeats if a new notification arrives during an active request', async () => {
    let resolveFirstRequest;
    let requestCount = 0;
    const context = {
        onlineOrdersLoading: false,
        onlineOrdersRefreshPending: false,
        onlineSeenPending: new Set(),
        onlinePendingOrderIds: new Set(),
        canHandleOnlineOrders: () => true,
        callOrderBridge: () => {
            requestCount++;
            if (requestCount === 1) {
                return new Promise(resolve => { resolveFirstRequest = resolve; });
            }
            return Promise.resolve({ orders: [] });
        },
        syncOnlineOrderAlert() {},
        renderOnlineOrderQueue() {},
        openOnlineOrdersModal() {},
        importAcceptedOnlineOrder: async () => {},
        $: id => id === 'online-orders-status'
            ? { classList: { toggle() {} }, textContent: '' }
            : { classList: { contains: () => false }, textContent: '0' },
        toast() {},
        console
    };
    const refreshOnlineOrders = extractFunction(
        '        async function refreshOnlineOrders()',
        '        function playOnlineOrderAlert()',
        'refreshOnlineOrders',
        context
    );

    const activeRequest = refreshOnlineOrders();
    await refreshOnlineOrders();
    resolveFirstRequest({ orders: [] });
    await activeRequest;
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(requestCount, 2);
});

test('inline scripts in the POS and online menu parse successfully', () => {
    for (const [file, source] of [['index.html', html], ['cardapio online.html', onlineMenuHtml]]) {
        const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
        assert.ok(scripts.length, `${file} should contain inline scripts`);
        scripts.forEach((script, index) => {
            if (script[1].trim()) {
                assert.doesNotThrow(
                    () => new vm.Script(script[1], { filename: `${file}#${index + 1}` }),
                    `${file} inline script ${index + 1} should parse`
                );
            }
        });
    }
});

test('online order staff authorization requires eight-digit privileged PINs', () => {
    assert.match(orderBridge, /!\/\^\\d\{4,8\}\$\/\.test\(pin\)/);
    assert.match(orderBridge, /const requiredPinLength = \["ADMIN", "GERENTE", "CAIXA"\]\.includes\(data\?\.role\) \? 8 : 4/);
    assert.match(orderBridge, /pin\.length !== requiredPinLength/);
});

test('online order acceptance does not wait for realtime notifications before printing can start', () => {
    const acceptStart = orderBridge.indexOf('if (body.action === "staff_accept" || body.action === "staff_reject")');
    const acceptEnd = orderBridge.indexOf('if (body.action === "staff_imported")', acceptStart);
    assert.notEqual(acceptStart, -1);
    assert.notEqual(acceptEnd, -1);
    const acceptHandler = orderBridge.slice(acceptStart, acceptEnd);
    assert.match(acceptHandler, /const notifications = Promise\.all\(/);
    assert.match(acceptHandler, /EdgeRuntime\.waitUntil\(notifications\)/);
    assert.doesNotMatch(acceptHandler, /await Promise\.all\(/);
});

test('online menu shows the updated restaurant name and address consistently', () => {
    assert.match(onlineMenuHtml, /<title>Restaurante e Pizzaria Gabryelle/);
    assert.match(onlineMenuHtml, /R\. Treze de Maio, 307/);
    assert.match(onlineMenuHtml, /Itapetinga - BA, 45700-000/);
    const restaurantMapsUrl = 'https://www.google.com/maps/place/Pizzaria+e+Churrascaria+Gabryelle/@-15.2553665,-40.2418047,19z/data=!3m1!4b1!4m6!3m5!1s0x7480bf4263ccbf3:0xba0a991b3675f76b!8m2!3d-15.2553678!4d-40.241161!16s%2Fg%2F1ydkj3c9m?entry=ttu&amp;g_ep=EgoyMDI2MTEwOS4wIKXMDSoASAFQAw%3D%3D';
    const mapsLinks = [...onlineMenuHtml.matchAll(/<a\b[^>]*href="([^"]*google\.com\/maps[^"]*)"[^>]*>/g)]
        .map(match => match[1]);
    assert.equal(mapsLinks.length, 2);
    assert.ok(mapsLinks.every(link => link === restaurantMapsUrl));
    assert.doesNotMatch(onlineMenuHtml, /Avenida Cinquentenário|Dricka Sorvete/);
});

test('only administrators can clear completed order history', async () => {
    let toastMessage = '';
    let saveCount = 0;
    const state = {
        orders: [
            { id: 1, paid: true, status: 'PRONTO', items: [] },
            { id: 2, paid: false, status: 'PENDENTE', items: [] }
        ],
        caixa: { movs: [] },
        caixaHistory: []
    };
    const context = {
        S: state,
        isAdmin: () => false,
        isOrderOpen: order => !order.paid && order.status !== 'CANCELADO',
        toast: message => { toastMessage = message; },
        confirm: () => true,
        renderAll() { throw new Error('Unauthorized action must not render or mutate.'); },
        save: async () => { saveCount++; return true; }
    };
    const limparHistoricoPedidos = extractFunction(
        '        function limparHistoricoPedidos(',
        '        function toggleOrderDetails(',
        'limparHistoricoPedidos',
        context
    );
    await limparHistoricoPedidos();

    assert.equal(state.orders.length, 2);
    assert.equal(saveCount, 0);
    assert.match(toastMessage, /Somente o administrador/);
});

test('admin order history cleanup leaves active orders and persists deletion tombstones', async () => {
    let saved = false;
    const context = {
        S: {
            orders: [
                { id: 10, paid: true, status: 'PRONTO', items: [{ name: 'Pizza', qty: 1, price: 20 }] },
                { id: 11, paid: false, status: 'PENDENTE', items: [] }
            ],
            caixa: { movs: [{ type: 'Venda', orderId: 10 }] },
            caixaHistory: []
        },
        isAdmin: () => true,
        isOrderOpen: order => !order.paid && order.status !== 'CANCELADO',
        toast() {},
        confirm: () => true,
        renderAll() {},
        save: async () => { saved = true; return true; }
    };
    const limparHistoricoPedidos = extractFunction(
        '        function limparHistoricoPedidos(',
        '        function toggleOrderDetails(',
        'limparHistoricoPedidos',
        context
    );
    await limparHistoricoPedidos();

    assert.deepEqual(JSON.parse(JSON.stringify(context.S.orders)), [
        { id: 11, paid: false, status: 'PENDENTE', items: [] }
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(context.S.deletedOrderHistoryIds)), ['10']);
    assert.ok(context.S.caixa.movs[0].orderSnapshot);
    assert.equal(saved, true);
});

test('cash history cleanup requires administrator and tombstones cleared sessions', async () => {
    let saved = false;
    const context = {
        S: {
            caixaHistory: [{ id: 'closed-1' }],
            caixa: { id: 'empty-closed-session', status: 'FECHADO' }
        },
        isAdmin: () => true,
        confirm: () => true,
        renderAll() {},
        save: async () => { saved = true; return true; },
        toast() {}
    };
    const limparHistoricoCaixa = extractFunction(
        '        async function limparHistoricoCaixa(',
        '        function verCaixaHistorico(',
        'limparHistoricoCaixa',
        context
    );
    await limparHistoricoCaixa();

    assert.deepEqual(JSON.parse(JSON.stringify(context.S.caixaHistory)), []);
    assert.deepEqual(JSON.parse(JSON.stringify(context.S.deletedCashHistoryIds)), [
        'closed-1',
        'empty-closed-session'
    ]);
    assert.equal(saved, true);
});

test('cash normalization does not re-archive a tombstoned session', () => {
    const context = {
        S: {
            orders: [],
            clientes: [],
            deletedOrderHistoryIds: [],
            deletedCashHistoryIds: ['deleted-session'],
            caixaHistory: [{ id: 'deleted-session' }],
            caixa: { id: 'deleted-session', status: 'FECHADO', movs: [], at: '2026-01-01T10:00:00Z' }
        },
        formatBrazilPhone: value => value,
        newCaixa: () => ({ id: 'new-session', status: 'FECHADO', movs: [] }),
        caixaResumo: () => ({})
    };
    const normalizeCaixaState = extractFunction(
        '        function normalizeCaixaState(',
        '        function setQzStatus(',
        'normalizeCaixaState',
        context
    );
    normalizeCaixaState();

    assert.deepEqual(JSON.parse(JSON.stringify(context.S.caixaHistory)), []);
    assert.equal(context.S.caixa.id, 'new-session');
});

test('cash normalization keeps empty closed placeholders out of history across reloads', () => {
    const context = {
        S: {
            orders: [],
            clientes: [],
            caixaHistory: [],
            caixa: { id: 'empty-session', status: 'FECHADO', movs: [], at: '2026-01-01T10:00:00Z' }
        },
        formatBrazilPhone: value => value,
        newCaixa: () => ({ id: 'next-empty-session', status: 'FECHADO', movs: [], skipHistoryArchive: true }),
        caixaResumo: () => ({})
    };
    const normalizeCaixaState = extractFunction(
        '        function normalizeCaixaState(',
        '        function setQzStatus(',
        'normalizeCaixaState',
        context
    );

    normalizeCaixaState();
    normalizeCaixaState();

    assert.deepEqual(JSON.parse(JSON.stringify(context.S.caixaHistory)), []);
});

test('shared state merge retains deletion tombstones and removes stale history', () => {
    let saveCount = 0;
    const context = {
        S: {
            orders: [],
            deletedOrderHistoryIds: ['old-order'],
            deletedCashHistoryIds: ['old-session']
        },
        sharedStateSaveCount: 0,
        sharedStateUpdatedAt: '',
        DEF: { cats: {} },
        normalizeCaixaState() {},
        renderAll() {},
        updateRolePermissions() {},
        save() { saveCount++; },
        scheduleRemoteOrderPrint() {},
        toast() {}
    };
    const applySharedState = extractFunction(
        '        function applySharedState(',
        '        function initPrintAgentPresence(',
        'applySharedState',
        context
    );

    applySharedState({
        updated_at: '2026-11-12T12:00:00.000Z',
        data: {
            orders: [{ id: 'old-order', paid: true, status: 'PRONTO' }],
            caixaHistory: [{ id: 'old-session' }],
            menu: { cats: {} }
        }
    }, true);

    assert.deepEqual(context.S.orders, []);
    assert.deepEqual(context.S.caixaHistory, []);
    assert.equal(saveCount, 1);
});
