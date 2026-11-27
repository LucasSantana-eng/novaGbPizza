const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'garçon.html'), 'utf8');
const start = html.indexOf('    window.salvarGarcom = async () => {');
const end = html.indexOf('    window.fecharModal =', start);
assert.ok(start !== -1 && end !== -1);

function setup(result, pin = '1234') {
    const messages = [];
    const input = { value: pin };
    const calls = [];
    const query = {
        select(value) { calls.push(['select', value]); return this; },
        eq(key, value) { calls.push(['eq', key, value]); return this; },
        async maybeSingle() {
            if (result instanceof Error) throw result;
            return result;
        }
    };
    const context = {
        window: {},
        loginPending: false,
        garcomAtual: '',
        supabase: { from: table => { calls.push(['from', table]); return query; } },
        document: { getElementById: id => id === 'selectGarcom' ? { value: '7' } : input },
        atualizarHeaderGarcom() {},
        fecharModal() {},
        showToast: message => messages.push(message),
        console: { error() {} }
    };
    vm.runInNewContext(html.slice(start, end), context);
    return { context, input, messages, calls };
}

test('identifica funcionário ativo pelo PIN da tabela usuarios', async () => {
    const env = setup({ data: { id: 7, name: 'Atendente', role: 'GARCOM', pin: '1234', active: true }, error: null });
    await env.context.window.salvarGarcom();
    assert.equal(env.context.garcomAtual, 'Atendente');
    assert.equal(env.input.value, '');
    assert.deepEqual(env.calls.filter(call => call[0] === 'eq'), [['eq', 'id', '7'], ['eq', 'active', true]]);
});

test('recusa PIN incorreto, funcionário inativo e falha de consulta', async () => {
    for (const result of [
        { data: { name: 'Atendente', pin: '9999', active: true }, error: null },
        { data: { name: 'Atendente', pin: '1234', active: false }, error: null },
        new Error('Rede indisponível')
    ]) {
        const env = setup(result);
        await env.context.window.salvarGarcom();
        assert.equal(env.context.garcomAtual, '');
        assert.equal(env.input.value, '');
        assert.ok(env.messages.length);
        assert.equal(env.context.loginPending, false);
    }
});

test('consulta pedidos abertos do caixa e inclui o serviço no total da mesa', () => {
    const begin = html.indexOf('    function normalizarMesas(');
    const finish = html.indexOf('    function normalizarCardapio(', begin);
    assert.ok(begin !== -1 && finish !== -1);
    const context = {};
    vm.runInNewContext(`${html.slice(begin, finish)}\nthis.normalizarMesas = normalizarMesas;`, context);
    const mesas = context.normalizarMesas({ orders: [
        { id: 1, type: 'MESA', mesa: 2, paid: false, status: 'PENDENTE', by: 'Atendente',
            total: 22, items: [{ name: 'Pizza', qty: 1, price: 20, det: ['Calabresa'], obs: 'Sem cebola' }] },
        { id: 2, type: 'MESA', mesa: '2', paid: false, status: 'PRONTO', by: 'Atendente',
            total: 11, items: [{ name: 'Suco', qty: 1, price: 10, det: [] }] },
        { id: 3, type: 'MESA', mesa: 2, paid: true, status: 'PRONTO', total: 50, items: [] },
        { id: 4, type: 'MESA', mesa: 3, paid: false, status: 'CANCELADO', total: 50, items: [] },
        { id: 5, type: 'DELIVERY', mesa: 2, paid: false, status: 'PENDENTE', total: 50, items: [] }
    ] });
    assert.equal(mesas[1].status, 'ocupada');
    assert.equal(mesas[1].total, 33);
    assert.deepEqual(Array.from(mesas[1].itens, item => item.nome), ['Pizza', 'Suco']);
    assert.deepEqual(Array.from(mesas[1].itens[0].detalhes), ['Calabresa']);
    assert.equal(mesas[2].status, 'livre');
    assert.throws(() => context.normalizarMesas({}), /lista de pedidos/);
});

test('preços do catálogo usam as promoções e categorias configuradas no caixa', () => {
    const shared = require('../menu-compartilhado.js');
    const menu = {
        cats: { Bebidas: [['Água', 5, 'Gelada']], Petiscos: [['Batata', 20, '']] },
        customItems: [{ id: 'suco', category: 'Bebidas', name: 'Suco', price: 12 }],
        promotionDays: [3],
        promoPrices: { 'item:0:0': 3, 'custom:suco': 10, 'pizza:pt:2': 40 }
    };
    const active = shared.menuItems(menu, 3);
    const inactive = shared.menuItems(menu, 4);
    assert.equal(active.find(item => item.n === 'Água').p, 3);
    assert.equal(active.find(item => item.n === 'Suco').p, 10);
    assert.equal(inactive.find(item => item.n === 'Água').p, 5);
    assert.equal(inactive.find(item => item.n === 'Suco').p, 12);
    assert.equal(shared.promotionPrice(menu, 'pizza:pt:2', 55, 3), 40);
    assert.equal(shared.promotionPrice(menu, 'pizza:pt:2', 55, 4), 55);
    menu.cats.Bebidas[0][1] = 8;
    menu.promoPrices['item:0:0'] = 7;
    assert.equal(shared.menuItems(menu, 3).find(item => item.n === 'Água').p, 7);
    menu.promoPrices['item:0:0'] = 9;
    assert.equal(shared.menuItems(menu, 3).find(item => item.n === 'Água').p, 8);
});

test('alteração de preço sincronizada atualiza o cardápio sem perder a categoria', () => {
    const begin = html.indexOf('    function normalizarCardapio(');
    const finish = html.indexOf('    window.abrirCardapio', begin);
    assert.ok(begin !== -1 && finish !== -1);
    const select = {
        value: 'Bebidas',
        options: [],
        replaceChildren() { this.options = []; this.value = ''; },
        appendChild(option) { this.options.push(option); if (!this.value) this.value = option.value; }
    };
    let renders = 0;
    const context = {
        cardapio: null,
        cardapioSignature: '',
        cardapioDay: null,
        document: { getElementById: () => select, createElement: () => ({}) },
        renderCardapio: () => renders++
    };
    vm.runInNewContext(`${html.slice(begin, finish)}\nthis.atualizar = atualizarCardapio;`, context);
    const menu = { cats: { Bebidas: [['Água', 5, '']] }, pt: [0, 0, 55, 65], pd: [0, 0, 55, 65], ac: [] };
    context.atualizar(menu);
    assert.equal(select.value, 'Bebidas');
    assert.equal(renders, 1);
    context.atualizar(menu);
    assert.equal(renders, 1);
    menu.cats.Bebidas[0][1] = 6;
    menu.promoPrices = { 'item:0:0': 4 };
    context.atualizar(menu);
    assert.equal(select.value, 'Bebidas');
    assert.equal(context.cardapio.cats.Bebidas[0][1], 6);
    assert.equal(renders, 2);
});

test('cardápio mostra categorias do caixa e busca produtos em todas elas', () => {
    const shared = require('../menu-compartilhado.js');
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const defaultStart = index.indexOf('        const DEF = {');
    const defaultEnd = index.indexOf('        const TABLE_COUNT', defaultStart);
    assert.ok(defaultStart !== -1 && defaultEnd !== -1);
    const defaults = {};
    vm.runInNewContext(`${index.slice(defaultStart, defaultEnd)}\nthis.menu = DEF;`, defaults);
    const menu = JSON.parse(JSON.stringify(defaults.menu));
    menu.customItems = [{ id: 'suco-especial', category: 'Sucos', name: 'Suco Especial', price: 12 }];
    menu.promotionDays = [new Date().getDay()];
    menu.promoPrices = { 'custom:suco-especial': 10 };
    const select = {
        value: '', options: [],
        replaceChildren() { this.options = []; this.value = ''; },
        appendChild(option) { this.options.push(option); if (!this.value) this.value = option.value; }
    };
    const search = { value: '' };
    const list = { innerHTML: '', textContent: '' };
    const context = {
        GabryelleMenu: shared, cardapio: null, cardapioSignature: '', cardapioDay: null,
        document: {
            getElementById: id => ({ cardapioCategoria: select, cardapioBusca: search, cardapioLista: list })[id],
            createElement: () => ({})
        },
        esc: String, fmtMoeda: String
    };
    context.window = context;
    const begin = html.indexOf('    function normalizarCardapio(');
    const finish = html.indexOf('    function montarItem(', begin);
    vm.runInNewContext(`${html.slice(begin, finish)}\nthis.atualizar = atualizarCardapio;`, context);
    context.atualizar(menu);
    assert.equal(select.value, '__todos__');
    for (const name of ['Petiscos', 'Bebidas', 'Drinks', 'Sucos', 'Massas', 'Cervejas', 'Whisky e Destilados']) {
        assert.ok(select.options.some(option => option.value === name), `Categoria ${name}`);
        assert.ok(list.innerHTML.includes(`<strong>${name}</strong>`), `Lista ${name}`);
    }
    assert.match(list.innerHTML, /Batata Frita Especial/);
    assert.match(list.innerHTML, /Whisky Red Label/);
    assert.match(list.innerHTML, /Suco Especial.*10 • PROMOÇÃO/);
    select.value = 'Pizzas';
    search.value = 'whisky';
    context.renderCardapio();
    assert.match(list.innerHTML, /Whisky Red Label/);
    assert.doesNotMatch(list.innerHTML, /Batata Frita Especial/);
    search.value = 'bebidas';
    context.renderCardapio();
    assert.match(list.innerHTML, /Refrigerante Lata/);
    select.value = 'Bebidas';
    context.alterarCategoriaCardapio();
    assert.equal(search.value, '');
    assert.match(list.innerHTML, /Refrigerante Lata/);
    assert.doesNotMatch(list.innerHTML, /Whisky Red Label/);
    menu.cats.Bebidas[0][1] = 9;
    context.atualizar(menu);
    assert.match(list.innerHTML, /Refrigerante Lata.*9/);
});

test('pedido usa preços atuais e valida pizza mista, acréscimos e produto removido', () => {
    const shared = require('../menu-compartilhado.js');
    const begin = html.indexOf('    function montarItem(');
    const finish = html.indexOf('    function podeAlterarRascunho(', begin);
    const context = { window: { GabryelleMenu: shared } };
    vm.runInNewContext(`${html.slice(begin, finish)}\nthis.montarItem = montarItem;`, context);
    const menu = {
        cats: { Bebidas: [['Água', 5, '']] }, customItems: [],
        pt: [0, 40, 50, 60], pd: [0, 45, 70, 80], mf: [4, 4, 4, 4],
        ac: [['Borda', 6]], promotionDays: [3], promoPrices: {}
    };
    const product = { kind: 'produto', key: 'item:0:0', name: 'Água', category: 'Bebidas', qty: 2, price: 5, obs: '' };
    assert.equal(context.montarItem(menu, product).price, 5);
    menu.cats.Bebidas[0][1] = 7;
    assert.equal(context.montarItem(menu, product).price, 7);
    const pizza = { kind: 'pizza', size: 2, sweet: false, flavors: ['Calabresa', 'Brigadeiro'], extras: [{ index: 0, name: 'Borda' }], qty: 1, obs: '' };
    const built = context.montarItem(menu, pizza);
    assert.equal(built.price, 76);
    assert.deepEqual(Array.from(built.det), ['Calabresa', 'Brigadeiro', '+ Borda']);
    menu.ac[0][0] = 'Outra borda';
    assert.throws(() => context.montarItem(menu, pizza), /acréscimo/);
    menu.cats.Bebidas[0][0] = 'Outro produto';
    assert.throws(() => context.montarItem(menu, product), /removido/);
});

test('pizza passa por sabores e adicionais, permite voltar e retorna à mesa ao adicionar', () => {
    const shared = require('../menu-compartilhado.js');
    const begin = html.indexOf('    function montarItem(');
    const end = html.indexOf('    function calcularTotalMesa(', begin);
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) {
            const classes = new Set();
            elements.set(id, {
                value: '', hidden: false, textContent: '', innerHTML: '', scrollTop: 0,
                classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) }
            });
        }
        return elements.get(id);
    };
    const messages = [];
    const menu = {
        cats: { Petiscos: [['Batata', 20, '']] }, customItems: [],
        pt: [0, 40, 50, 60], pd: [0, 45, 70, 80], mf: [4, 4, 2, 4],
        ac: [['Borda', 6]], promotionDays: [], promoPrices: {}
    };
    const context = {
        GabryelleMenu: shared, garcomAtual: 'Teste', mesaSelecionadaNumero: 3,
        cardapio: menu, itensRascunho: [], pizzaRascunho: null,
        erroPedidoPendente: '', pedidoPendente: null, envioEmAndamento: false, previaEmAndamento: false,
        document: { getElementById: element },
        esc: String, fmtMoeda: String, showToast: msg => messages.push(msg),
        fecharModal: id => element(id).classList.remove('open'), renderModalMesa() {}
    };
    context.window = context;
    vm.runInNewContext(html.slice(begin, end), context);
    element('modalCardapio').classList.add('open');
    context.abrirPizza(2, false);
    context.avancarPizza();
    assert.equal(element('pizzaEtapaAdicionais').hidden, true);
    assert.match(messages.pop(), /sabores/);
    context.selecionarSaborPizza(shared.PZ.findIndex(flavor => flavor[0] === 'Calabresa'), true);
    context.avancarPizza();
    assert.equal(element('pizzaEtapaSabores').hidden, true);
    assert.equal(element('pizzaEtapaAdicionais').hidden, false);
    context.selecionarAcrescimoPizza(0, true);
    element('pizzaObs').value = 'Sem cebola';
    context.voltarSaboresPizza();
    assert.equal(element('pizzaEtapaSabores').hidden, false);
    assert.match(element('pizzaSabores').innerHTML, /checked/);
    context.avancarPizza();
    assert.match(element('pizzaAcrescimos').innerHTML, /checked/);
    assert.equal(element('pizzaObs').value, 'Sem cebola');
    context.adicionarPizza();
    assert.equal(element('modalPizza').classList.contains('open'), false);
    assert.equal(element('modalCardapio').classList.contains('open'), false);
    assert.equal(element('modalMesa').classList.contains('open'), true);
    assert.equal(context.itensRascunho[0].price, 56);
    assert.equal(context.itensRascunho[0].obs, 'Sem cebola');
    assert.equal(context.itensRascunho[0].extras[0].name, 'Borda');
});

test('petisco retorna à mesa apenas quando é adicionado com sucesso', () => {
    const shared = require('../menu-compartilhado.js');
    const begin = html.indexOf('    function montarItem(');
    const end = html.indexOf('    window.abrirPizza', begin);
    const closed = [];
    const mesaClasses = new Set();
    const menu = { cats: { Petiscos: [['Batata', 20, '']] }, customItems: [], promotionDays: [], promoPrices: {} };
    const context = {
        GabryelleMenu: shared, garcomAtual: 'Teste', mesaSelecionadaNumero: 3,
        cardapio: menu, itensRascunho: [], erroPedidoPendente: '', pedidoPendente: null, envioEmAndamento: false, previaEmAndamento: false,
        document: { getElementById: () => ({ classList: { add: name => mesaClasses.add(name) } }) },
        fecharModal: id => closed.push(id), renderModalMesa() {}, showToast() {}
    };
    context.window = context;
    vm.runInNewContext(html.slice(begin, end), context);
    const index = shared.menuItems(menu).findIndex(item => item.n === 'Batata');
    menu.cats.Petiscos[0][1] = 0;
    context.adicionarItemCardapio(index);
    assert.deepEqual(closed, []);
    assert.equal(context.itensRascunho.length, 0);
    menu.cats.Petiscos[0][1] = 20;
    context.adicionarItemCardapio(index);
    assert.deepEqual(closed, ['modalCardapio']);
    assert.equal(mesaClasses.has('open'), true);
    assert.equal(context.itensRascunho.length, 1);
});

test('envio incerto é repetido com o mesmo identificador sem armazenar o PIN', async () => {
    const shared = require('../menu-compartilhado.js');
    const itemStart = html.indexOf('    function montarItem(');
    const itemEnd = html.indexOf('    function podeAlterarRascunho(', itemStart);
    const sendStart = html.indexOf('    function novoIdentificadorPedido(');
    const sendEnd = html.indexOf('    window.sincronizarTudo', sendStart);
    const storage = new Map();
    const calls = [];
    const closed = [];
    const messages = [];
    const broadcasts = [];
    const menu = { cats: { Bebidas: [['Água', 5, '']] }, customItems: [], pt: [], pd: [], ac: [], promotionDays: [], promoPrices: {}, svc: 10 };
    const context = {
        window: { GabryelleMenu: shared, crypto: { randomUUID: () => 'fixed-uuid' } },
        garcomAtual: 'Teste', garcomId: '1', garcomPin: '1234',
        canalImpressaoAtivo: true,
        canalImpressao: { send: message => { broadcasts.push(message); return new Promise(() => {}); } },
        pedidoPendente: null, erroPedidoPendente: '', envioEmAndamento: false, previaEmAndamento: false,
        mesaSelecionadaNumero: 3, cardapio: menu,
        itensRascunho: [{ kind: 'produto', key: 'item:0:0', name: 'Água', category: 'Bebidas', qty: 1, price: 5, obs: '' }],
        PENDING_REQUEST_KEY: 'pending', TABELA_STATE: 'app_state',
        sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        document: { getElementById: () => ({ checked: true }) },
        normalizarCardapio: value => value,
        supabase: {
            from: () => ({ select() { return this; }, eq() { return this; }, single: async () => ({ data: { data: { _revision: 4, _tableOrderVersion: 1, menu } } }) }),
            rpc: async (_name, params) => {
                calls.push(params);
                if (calls.length === 1) throw new Error('Rede interrompida');
                return { data: { id: 8, mesa: 3 }, error: null };
            }
        },
        confirm: () => true, fmtMoeda: String, showToast: msg => messages.push(msg), renderModalMesa() {}, fecharModal: id => closed.push(id),
        carregarAppState: async () => {}, console: { error() {} }
    };
    vm.runInNewContext(`${html.slice(itemStart, itemEnd)}\n${html.slice(sendStart, sendEnd)}`, context);
    await context.window.enviarPedidoMesa();
    assert.equal(broadcasts.length, 0);
    assert.equal(context.pedidoPendente.params.p_request_id, 'fixed-uuid');
    assert.equal(storage.get('pending').includes('1234'), false);
    assert.deepEqual(closed, []);
    assert.equal(context.mesaSelecionadaNumero, 3);
    context.carregarAppState = async () => { throw new Error('Rede indisponível'); };
    await context.window.enviarPedidoMesa();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].p_request_id, calls[1].p_request_id);
    assert.deepEqual(JSON.parse(JSON.stringify(broadcasts)), [
        { type: 'broadcast', event: 'table-order-committed', payload: {} }
    ]);
    assert.equal(calls[0].p_service, true);
    assert.equal(context.pedidoPendente, null);
    assert.equal(storage.has('pending'), false);
    assert.deepEqual(closed, ['modalMesa']);
    assert.equal(context.mesaSelecionadaNumero, null);
    assert.match(messages.at(-1), /confirmado.*Atualize/);
});

test('confirmação de envio anterior preserva a escolha de serviço do pedido pendente', async () => {
    const sendStart = html.indexOf('    function novoIdentificadorPedido(');
    const sendEnd = html.indexOf('    window.sincronizarTudo', sendStart);
    const calls = [];
    const context = {
        window: {}, garcomAtual: 'Teste', garcomId: '1', garcomPin: '1234',
        canalImpressaoAtivo: false,
        pedidoPendente: { params: { p_request_id: 'antigo', p_employee_id: '1', p_table: 3, p_service: false } },
        erroPedidoPendente: '', envioEmAndamento: false, previaEmAndamento: false, mesaSelecionadaNumero: 3,
        itensRascunho: [{}], PENDING_REQUEST_KEY: 'pending', TABELA_STATE: 'app_state',
        sessionStorage: { removeItem() {} },
        supabase: {
            from: () => ({ select() { return this; }, eq() { return this; }, single: async () => ({ data: { data: { _tableOrderVersion: 1 } } }) }),
            rpc: async (_name, params) => { calls.push(params); return { data: { id: 8, mesa: 3 } }; }
        },
        fecharModal() {}, renderModalMesa() {}, carregarAppState: async () => {}, showToast() {}, console: { error() {}, warn() {} }
    };
    vm.runInNewContext(html.slice(sendStart, sendEnd), context);
    await context.window.enviarPedidoMesa();
    assert.equal(calls[0].p_service, false);
    assert.equal(calls[0].p_request_id, 'antigo');
});

test('falha ou indisponibilidade do aviso imediato não invalida o pedido confirmado', async () => {
    const start = html.indexOf('    function novoIdentificadorPedido(');
    const end = html.indexOf('    window.sincronizarTudo', start);
    for (const mode of ['unavailable', 'timeout', 'reject', 'throw']) {
        const warnings = [];
        const messages = [];
        const context = {
            window: {}, garcomAtual: 'Teste', garcomId: '1', garcomPin: '1234',
            canalImpressaoAtivo: mode !== 'unavailable',
            canalImpressao: { send() {
                if (mode === 'throw') throw new Error('Canal indisponível');
                if (mode === 'reject') return Promise.reject(new Error('Rede indisponível'));
                return Promise.resolve('timed out');
            } },
            pedidoPendente: { params: { p_employee_id: '1', p_request_id: 'same-request' } },
            erroPedidoPendente: '', envioEmAndamento: false, previaEmAndamento: false,
            mesaSelecionadaNumero: 3, itensRascunho: [{}], PENDING_REQUEST_KEY: 'pending', TABELA_STATE: 'app_state',
            sessionStorage: { removeItem() {} },
            supabase: {
                from: () => ({ select() { return this; }, eq() { return this; }, single: async () => ({ data: { data: { _tableOrderVersion: 1 } } }) }),
                rpc: async () => ({ data: { id: 8, mesa: 3 } })
            },
            fecharModal() {}, renderModalMesa() {}, carregarAppState: async () => {},
            showToast: message => messages.push(message),
            console: { error() {}, warn: (...args) => warnings.push(args) }
        };
        vm.runInNewContext(html.slice(start, end), context);
        await context.window.enviarPedidoMesa();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(context.pedidoPendente, null, mode);
        assert.equal(context.mesaSelecionadaNumero, null, mode);
        assert.match(messages.at(-1), /Pedido #8 lançado/, mode);
        assert.equal(warnings.length, 1, mode);
    }
});

test('impede o envio para um banco que ainda não recebeu a migração de comandas', async () => {
    const sendStart = html.indexOf('    function novoIdentificadorPedido(');
    const sendEnd = html.indexOf('    window.sincronizarTudo', sendStart);
    const messages = [];
    let submitted = false;
    const context = {
        window: {}, garcomAtual: 'Teste', garcomId: '1', garcomPin: '1234',
        canalImpressaoAtivo: false,
        pedidoPendente: { params: { p_employee_id: '1' } }, erroPedidoPendente: '',
        envioEmAndamento: false, previaEmAndamento: false, mesaSelecionadaNumero: 3,
        TABELA_STATE: 'app_state',
        supabase: {
            from: () => ({ select() { return this; }, eq() { return this; }, single: async () => ({ data: { data: { _revision: 1 } } }) }),
            rpc: async () => { submitted = true; }
        },
        showToast: message => messages.push(message), console
    };
    vm.runInNewContext(html.slice(sendStart, sendEnd), context);
    await context.window.enviarPedidoMesa();
    assert.equal(submitted, false);
    assert.ok(context.pedidoPendente);
    assert.match(messages[0], /Atualize o banco/);
});

function setupPreview({ printer = true, status = 'printed', createError = false, unauthorized = false, draft = false } = {}) {
    const shared = require('../mesa-conta-compartilhada.js');
    const start = html.indexOf('    const agentesImpressao = new Map();');
    const end = html.indexOf('    function novoIdentificadorPedido(', start);
    const listeners = {};
    const calls = [];
    const messages = [];
    const closed = [];
    const statusElement = { textContent: '', hidden: true };
    const orders = [
        { id: 1, type: 'MESA', mesa: 3, status: 'PENDENTE', paid: false, items: [{ name: 'Pizza', qty: 1, price: 50, det: [] }], sub: 50, svc: 5, total: 55 },
        { id: 2, type: 'MESA', mesa: 3, status: 'PRONTO', paid: false, items: [{ name: 'Água', qty: 1, price: 5, det: [] }], sub: 5, svc: 0.5, total: 5.5 },
        { id: 3, type: 'MESA', mesa: 3, status: 'CANCELADO', paid: false, items: [], total: 80 },
        { id: 4, type: 'MESA', mesa: 3, status: 'PRONTO', paid: true, items: [], total: 80 }
    ];
    const channel = {
        on(_type, _filter, callback) { listeners.status = callback; return this; },
        subscribe(callback) { callback('SUBSCRIBED'); return this; },
        async send(message) {
            if (message.event === 'status-request' && printer) {
                listeners.status({ payload: { sourceId: 'caixa-1', connected: true, sentAt: Date.now() } });
            }
            return 'ok';
        }
    };
    const context = {
        window: { GabryelleMesa: shared }, SUPABASE_URL: 'https://exemplo.test', SUPABASE_KEY: 'publica',
        supabase: {
            channel: () => channel,
            from: () => ({ select() { return this; }, eq() { return this; }, async single() { return { data: { data: { orders } } }; } })
        },
        TABELA_STATE: 'app_state', garcomAtual: 'Teste', garcomId: '1', garcomPin: '1234',
        mesaSelecionadaNumero: 3, itensRascunho: draft ? [{}] : [], pedidoPendente: null, erroPedidoPendente: '',
        envioEmAndamento: false, previaEmAndamento: false, mesaPreviaNumero: null, mensagemPrevia: '',
        document: { getElementById: () => statusElement },
        fecharModal: id => closed.push(id), renderModalMesa() {}, showToast: message => messages.push(message),
        setTimeout: resolve => resolve(), console: { error() {}, warn() {} },
        fetch: async (_url, options) => {
            const body = JSON.parse(options.body);
            calls.push(body);
            if (body.action === 'table_preview_create' && createError) throw new Error('Rede');
            if (body.action === 'table_preview_create' && unauthorized) {
                return { ok: false, status: 401, json: async () => ({ error: 'Acesso não autorizado.' }) };
            }
            return { ok: true, json: async () => body.action === 'table_preview_create' ? { jobId: 'job-1' } : { status } };
        }
    };
    vm.runInNewContext(html.slice(start, end), context);
    return { context, calls, messages, orders, closed, statusElement };
}

test('pré-conta usa pedidos abertos atualizados e confirma impressão sem registrar pagamento', async () => {
    const env = setupPreview();
    const before = JSON.stringify(env.orders);
    const requesting = env.context.window.solicitarPreviaMesa();
    assert.deepEqual(env.closed, ['modalMesa']);
    assert.equal(env.context.mesaSelecionadaNumero, null);
    assert.equal(env.statusElement.hidden, false);
    assert.match(env.statusElement.textContent, /^Mesa 3: Procurando/);
    await requesting;
    assert.deepEqual(env.calls.map(call => call.action), ['table_preview_create', 'table_preview_status']);
    const bill = env.calls[0].bill;
    assert.equal(bill.mesa, 3);
    assert.equal(bill.accountPreview, true);
    assert.equal(bill.waiterPreview, true);
    assert.equal(bill.sub, 55);
    assert.equal(bill.svc, 5.5);
    assert.equal(bill.total, 60.5);
    assert.equal(bill.paid, false);
    assert.equal(bill.pay, '');
    assert.equal(bill.items.length, 2);
    assert.equal(JSON.stringify(env.orders), before);
    assert.match(env.context.mensagemPrevia, /enviada à impressora.*pagamento.*caixa/);
    assert.match(env.statusElement.textContent, /^Mesa 3: Pré-conta enviada/);
    assert.equal(env.context.previaEmAndamento, false);
});

test('pré-conta informa falha ou resultado incerto e não solicita quando há itens pendentes', async () => {
    const offline = setupPreview({ printer: false });
    await offline.context.window.solicitarPreviaMesa();
    assert.equal(offline.calls.length, 0);
    assert.match(offline.context.mensagemPrevia, /não impressa/);
    assert.match(offline.statusElement.textContent, /^Mesa 3: Pré-conta não impressa/);
    const failed = setupPreview({ status: 'failed' });
    await failed.context.window.solicitarPreviaMesa();
    assert.match(failed.context.mensagemPrevia, /não impressa/);
    const uncertain = setupPreview({ createError: true });
    await uncertain.context.window.solicitarPreviaMesa();
    assert.equal(uncertain.calls.length, 1);
    assert.match(uncertain.context.mensagemPrevia, /não confirmada.*antes de tentar novamente/);
    const unauthorized = setupPreview({ unauthorized: true });
    await unauthorized.context.window.solicitarPreviaMesa();
    assert.match(unauthorized.context.mensagemPrevia, /Acesso não autorizado.*PIN/);
    const pending = setupPreview({ draft: true });
    await pending.context.window.solicitarPreviaMesa();
    assert.equal(pending.calls.length, 0);
    assert.match(pending.messages[0], /não enviados/);
    assert.deepEqual(pending.closed, []);
});

test('pré-conta em andamento não interfere ao selecionar outra mesa', async () => {
    const env = setupPreview();
    const requesting = env.context.window.solicitarPreviaMesa();
    env.context.mesaSelecionadaNumero = 4;
    await requesting;
    assert.equal(env.context.mesaSelecionadaNumero, 4);
    assert.deepEqual(env.closed, ['modalMesa']);
    assert.match(env.statusElement.textContent, /^Mesa 3: Pré-conta enviada/);

    const begin = html.indexOf('    function podeAlterarRascunho()');
    const end = html.indexOf('    window.adicionarItemCardapio', begin);
    env.context.previaEmAndamento = true;
    vm.runInNewContext(html.slice(begin, end), env.context);
    assert.equal(env.context.podeAlterarRascunho(), true);
    env.context.mesaSelecionadaNumero = 3;
    assert.equal(env.context.podeAlterarRascunho(), false);
    assert.match(env.messages.at(-1), /pré-conta desta mesa/);
});

test('manifesto instala somente o garçom e usa ícones PNG nos tamanhos necessários', () => {
    const root = path.join(__dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'garcom.webmanifest'), 'utf8'));
    const base = 'https://exemplo.test/pizzaria/';
    const startUrl = new URL(manifest.start_url, base);
    const scope = new URL(manifest.scope, base);
    assert.equal(startUrl.pathname, '/pizzaria/gar%C3%A7on.html');
    assert.equal(scope.pathname, startUrl.pathname);
    assert.equal(manifest.display, 'standalone');
    for (const size of [192, 512]) {
        const icon = manifest.icons.find(entry => entry.sizes === `${size}x${size}`);
        assert.ok(icon);
        const png = fs.readFileSync(path.join(root, ...icon.src.split('/')));
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(png.readUInt32BE(16), size);
        assert.equal(png.readUInt32BE(20), size);
    }
    const iosIcon = fs.readFileSync(path.join(root, 'assets', 'garcom-icon-180.png'));
    assert.equal(iosIcon.readUInt32BE(16), 180);
    assert.equal(iosIcon.readUInt32BE(20), 180);
});

function setupInstall({ userAgent = 'Android', secure = true, installed = false, registrationError = false } = {}) {
    const events = {};
    const elements = {};
    const element = id => {
        if (!elements[id]) {
            const handlers = {};
            const classes = new Set();
            elements[id] = {
                handlers, hidden: false, textContent: '',
                classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
                addEventListener: (name, handler) => { handlers[name] = handler; }
            };
        }
        return elements[id];
    };
    const registrations = [];
    const context = {
        window: {
            isSecureContext: secure,
            matchMedia: () => ({ matches: installed, addEventListener() {} }),
            addEventListener: (name, handler) => { events[name] = handler; }
        },
        navigator: {
            userAgent, platform: '', maxTouchPoints: 0,
            serviceWorker: {
                register: (script, options) => {
                    registrations.push({ script, scope: options.scope });
                    return registrationError ? Promise.reject(new Error('Rede')) : Promise.resolve();
                }
            }
        },
        document: { getElementById: element },
        console: { error() {} }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'garcom-instalacao.js'), 'utf8'), context);
    return { events, element, registrations };
}

test('instalação no Android usa o convite do navegador e oculta o botão após instalar', async () => {
    const env = setupInstall();
    assert.deepEqual(env.registrations, [{ script: './garcom-sw.js', scope: './gar%C3%A7on.html' }]);
    let prevented = false;
    let prompted = false;
    env.events.beforeinstallprompt({ preventDefault() { prevented = true; }, async prompt() { prompted = true; } });
    await env.element('btnInstalar').handlers.click();
    assert.equal(prevented, true);
    assert.equal(prompted, true);
    env.events.appinstalled();
    assert.equal(env.element('btnInstalar').hidden, true);
});

test('instalação orienta iPhone, conexão insegura e falha de preparação', async () => {
    const ios = setupInstall({ userAgent: 'iPhone' });
    await ios.element('btnInstalar').handlers.click();
    assert.match(ios.element('instrucoesInstalacao').textContent, /Safari.*Compartilhar.*Tela de Início/);
    assert.equal(ios.element('modalInstalacao').classList.contains('open'), true);
    ios.element('fecharInstalacao').handlers.click();
    assert.equal(ios.element('modalInstalacao').classList.contains('open'), false);
    const insecure = setupInstall({ secure: false });
    await insecure.element('btnInstalar').handlers.click();
    assert.match(insecure.element('instrucoesInstalacao').textContent, /HTTPS/);
    assert.equal(insecure.registrations.length, 0);
    const failure = setupInstall({ registrationError: true });
    await new Promise(resolve => setImmediate(resolve));
    await failure.element('btnInstalar').handlers.click();
    assert.match(failure.element('instrucoesInstalacao').textContent, /Não foi possível preparar/);
    assert.equal(setupInstall({ installed: true }).element('btnInstalar').hidden, true);
});
