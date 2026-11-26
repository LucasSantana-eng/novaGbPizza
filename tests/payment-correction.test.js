const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function setup({ closed = false, role = 'ADMIN', online = false } = {}) {
    const messages = [];
    const answers = ['2', 'Pagamento registrado incorretamente'];
    const payments = ['Dinheiro', 'PIX', 'Cartão de Crédito', 'Cartão de Débito'];
    const session = {
        id: 1, initial: 5, status: closed ? 'FECHADO' : 'ABERTO',
        movs: [
            { type: 'Venda', desc: 'Pedido Nº 7 (Delivery)', orderId: 7, orderType: 'DELIVERY', pay: 'Dinheiro', v: 20, cashReceived: 25, change: 5 },
            { type: 'Venda', desc: 'Pedido Nº 7 (Delivery)', orderId: 7, orderType: 'DELIVERY', pay: 'Cartão de Crédito', v: 10 }
        ]
    };
    const order = { id: 7, paid: true, pay: 'Dinheiro + Cartão de Crédito', change: 5 };
    const context = {
        S: { orders: [order], caixa: closed ? { id: 2, status: 'ABERTO', movs: [] } : session, caixaHistory: closed ? [session] : [] },
        PAYS: payments, currentUser: { role, id: 9, name: 'Admin' },
        isAdmin() { return context.currentUser.role === 'ADMIN'; },
        caixaAberto() { return context.S.caixa.status === 'ABERTO'; },
        cashStatusSyncPending: false, orderCancellationPending: false, deliveryDispatchPending: false,
        supabaseClient: online ? {} : null, syncSharedState: async () => true,
        prompt: () => answers.shift(), confirm: () => true,
        money: value => String(value), toast: message => messages.push(message),
        renderAll() {}, save: async () => true
    };
    const start = html.indexOf('        function caixaResumo(');
    const end = html.indexOf('        function caixaDateKey(', start);
    const helpersStart = html.indexOf('        function correctedCashSummary(');
    const helpersEnd = html.indexOf('        function caixaRelatorioHtml(', helpersStart);
    assert.ok(start !== -1 && end !== -1 && helpersStart !== -1 && helpersEnd !== -1);
    vm.runInNewContext(`${html.slice(start, end)}\n${html.slice(helpersStart, helpersEnd)}\nthis.correct = correctPaymentMethod; this.summary = correctedCashSummary;`, context);
    return { context, session, order, messages };
}

test('administrator corrects one split payment without changing the amount', async () => {
    const env = setup();
    await env.context.correct(1, 0, false);
    assert.equal(env.session.movs[0].pay, 'PIX');
    assert.equal(env.session.movs[0].v, 20);
    assert.equal(env.session.movs[1].pay, 'Cartão de Crédito');
    assert.equal(env.order.pay, 'PIX + Cartão de Crédito');
    assert.equal(env.order.change, 0);
    assert.equal(env.session.movs[0].paymentCorrections[0].cashReceived, 25);
    assert.equal(env.session.movs[0].paymentCorrections[0].reason, 'Pagamento registrado incorretamente');
});

test('closed cash correction works without the deleted order and preserves original closing', async () => {
    const env = setup({ closed: true });
    env.context.S.orders = [];
    env.session.summary = env.context.summary(env.session);
    env.session.remainingCash = 12;
    await env.context.correct(1, 0, true);
    assert.equal(env.session.movs[0].pay, 'Dinheiro');
    assert.equal(env.session.summary.byPayment.Dinheiro, 20);
    assert.equal(env.session.remainingCash, 12);
    const corrected = env.context.summary(env.session);
    assert.equal(corrected.byPayment.Dinheiro, 0);
    assert.equal(corrected.byPayment.PIX, 20);
    assert.equal(corrected.drawerCash, 5);
    assert.equal(corrected.sales, 30);
    assert.equal(env.session.paymentCorrections[0].desc, 'Pedido Nº 7 (Delivery)');
});

test('multiple corrections of the same closed payment use the last corrected method', async () => {
    const env = setup({ closed: true });
    await env.context.correct(1, 0, true);
    const answers = ['4', 'Nova conferência'];
    env.context.prompt = () => answers.shift();
    await env.context.correct(1, 0, true);
    const corrected = env.context.summary(env.session);
    assert.equal(env.session.paymentCorrections[1].from, 'PIX');
    assert.equal(corrected.byPayment.PIX, 0);
    assert.equal(corrected.byPayment['Cartão de Débito'], 20);
    assert.equal(corrected.byPayment['Cartão de Crédito'], 10);
});

test('non-admin and changed shared cash cannot be corrected', async () => {
    const denied = setup({ role: 'CAIXA' });
    await denied.context.correct(1, 0, false);
    assert.equal(denied.session.movs[0].pay, 'Dinheiro');
    assert.match(denied.messages[0], /administrador/);

    const stale = setup({ online: true });
    stale.context.syncSharedState = async () => { stale.session.movs[0].v = 19; return true; };
    await stale.context.correct(1, 0, false);
    assert.equal(stale.session.movs[0].pay, 'Dinheiro');
    assert.match(stale.messages[0], /mudaram/);
});
