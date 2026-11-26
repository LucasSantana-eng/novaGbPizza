const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const root = path.join(__dirname, '..');
const pos = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const online = fs.readFileSync(path.join(root, 'cardapio online.html'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'order-bridge', 'index.ts'), 'utf8');

function extract(source, start, end, name, context = {}, typescript = false) {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    assert.ok(first !== -1 && last !== -1);
    let code = source.slice(first, last);
    if (typescript) code = stripTypeScriptTypes(code);
    vm.runInNewContext(`${code}\nthis.fn = ${name};`, context);
    return context.fn;
}

test('new delivery and pickup orders remain unpaid regardless of the initial payment selection', () => {
    const context = {
        S: { seq: 1, orders: [] },
        caixaAberto: () => false,
        upsertCli() {},
        payOrder() { throw new Error('Payment must not be registered at order creation'); },
        renderAll() {},
        toast() { throw new Error('Order creation should not require an open cash session'); }
    };
    const finalize = extract(pos, '        function finalize(', '        function payOrder(', 'finalize', context);
    for (const order of [
        { type: 'DELIVERY', taxa: 6, items: [{ qty: 1, price: 20 }] },
        { type: 'BALCAO', serviceType: 'RETIRADA', items: [{ qty: 1, price: 20 }] }
    ]) {
        finalize(order, 'PIX');
        assert.equal(order.paid, false);
        assert.equal(order.status, 'PENDENTE');
    }
});

test('online cash change payload is validated, while old online orders remain compatible', { skip: typeof stripTypeScriptTypes !== 'function' }, () => {
    const build = extract(online, '        function roundOnlineMoney(', '        function createOnlineOrderIdentity(', 'buildOnlineOrderPayload');
    const validate = extract(bridge, 'function isValidOrder(', 'Deno.serve(', 'isValidOrder', {}, true);
    const form = {
        customerName: 'Cliente', customerPhone: '(77) 99999-9999', deliveryType: 'delivery',
        address: 'Rua 1', complement: '', deliveryFee: 5, payment: 'Dinheiro',
        needsChange: true, cashChangeFor: 50
    };
    const payload = build(form, [{ name: 'Pizza', size: 'Padrão', qty: 1, price: 20 }]);
    assert.equal(payload.total, 25);
    assert.equal(payload.cashChangeFor, 50);
    assert.equal(validate(payload), true);
    assert.equal(validate({ ...payload, cashChangeFor: 24 }), false);
    assert.equal(validate({ ...payload, cashChangeFor: 50.001 }), false);
    assert.equal(validate({ ...payload, payment: 'Pix' }), false);
    assert.equal(validate({ ...payload, needsChange: false }), false);
    delete payload.needsChange;
    delete payload.cashChangeFor;
    assert.equal(validate(payload), true);
});

test('online cash change is preserved when the order is imported for printing', async () => {
    let imported;
    const context = {
        S: { orders: [], menu: { svc: 10 } },
        KEY: 'state',
        localStorage: { setItem() {} },
        supabaseClient: { from: () => ({ upsert: async () => ({ error: null }) }) },
        sharedStateSaveCount: 0,
        shouldDelegateAcceptedOnlinePrint: () => false,
        formatBrazilPhone: value => value || '',
        finalize: order => { imported = order; return order; },
        callOrderBridge: async () => {}
    };
    const importOrder = extract(pos, '        async function importAcceptedOnlineOrder(', '        function switchTab(', 'importAcceptedOnlineOrder', context);
    await importOrder({
        id: 'online',
        payload: {
            deliveryType: 'delivery', payment: 'Dinheiro', needsChange: true,
            cashChangeFor: 50, total: 25, items: [{ name: 'Pizza', qty: 1, price: 20 }]
        }
    });
    assert.equal(imported.needsChange, true);
    assert.equal(imported.cashChangeFor, 50);
    assert.equal(imported.payPref, 'Dinheiro');
});
