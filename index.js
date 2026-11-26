const { createClient } = require('@supabase/supabase-js');
const { ThermalPrinter, PrinterTypes, CharacterSet } = require('node-thermal-printer');
const printerDriver = require('printer');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ciousuoedyezkltyfvqb.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_hts4YS3W97DfKWQQSq3XAw_zdgtNteA';
const PRINTER_INTERFACE = process.env.PRINTER_INTERFACE || 'printer:\\\\localhost\\Elgin-i9';
const STATE_ID = 'gp_state';
const LEGACY_PRINT_SERVICE_ENABLED = process.env.LEGACY_PRINT_SERVICE_ENABLED === 'true';

if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Configure SUPABASE_URL e SUPABASE_KEY antes de iniciar o serviço.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
        persistSession: false,
        autoRefreshToken: false
    }
});

const currency = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
});

function text(value, fallback = '-') {
    if (value === undefined || value === null || String(value).trim() === '') {
        return fallback;
    }
    return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

function money(value) {
    const amount = Number(value);
    return currency.format(Number.isFinite(amount) ? amount : 0);
}

function orderLocation(order) {
    if (order.type === 'MESA') return `MESA ${text(order.mesa)}`;
    if (order.type === 'DELIVERY') return 'DELIVERY';
    if (order.serviceType === 'RETIRADA') return 'RETIRADA';
    return 'BALCÃO';
}

function getItemDetails(item) {
    if (Array.isArray(item.det)) return item.det.map(detail => text(detail)).filter(Boolean);
    if (item.det) return [text(item.det)];
    return [];
}

function createPrinter() {
    return new ThermalPrinter({
        type: PrinterTypes.EPSON,
        interface: PRINTER_INTERFACE,
        driver: printerDriver,
        characterSet: CharacterSet.PC860_PORTUGUESE,
        removeSpecialCharacters: false,
        width: 42,
        lineCharacter: '-'
    });
}

async function printKitchenTicket(order) {
    const printer = createPrinter();
    const items = Array.isArray(order.items) ? order.items : [];
    const itemCount = items.reduce((total, item) => total + (Number(item.qty) || 0), 0);

    printer.alignCenter();
    printer.bold(true);
    printer.setTextSize(1, 2);
    printer.println(`#${text(order.id)}`);
    printer.setTextSize(1, 1);
    printer.println(orderLocation(order).toUpperCase());
    printer.println(`ATENDENTE: ${text(order.by, 'Não informado')}`);
    printer.bold(false);
    printer.drawLine();
    printer.alignLeft();

    for (const item of items) {
        const quantity = Number(item.qty) || 0;
        printer.bold(true);
        printer.println(`${quantity}x ${text(item.name, 'ITEM').toUpperCase()}`);
        printer.bold(false);
        for (const detail of getItemDetails(item)) {
            printer.println(`  - ${detail}`);
        }
        if (item.obs) printer.println(`  OBS: ${text(item.obs)}`);
    }

    printer.drawLine();
    printer.bold(true);
    printer.println(`TOTAL DE ITENS: ${itemCount}`);
    printer.bold(false);
    printer.cut();
    await printer.execute();
    console.log(`🧑‍🍳 Via da cozinha impressa para o pedido #${text(order.id)}.`);
}

async function printCashierTicket(order) {
    const printer = createPrinter();
    const items = Array.isArray(order.items) ? order.items : [];
    const subtotal = items.reduce(
        (total, item) => total + (Number(item.qty) || 0) * (Number(item.price) || 0),
        0
    );
    const deliveryFee = Number(order.taxa) || 0;
    const serviceFee = Number(order.svc) || 0;
    const total = Number.isFinite(Number(order.total))
        ? Number(order.total)
        : subtotal + deliveryFee + serviceFee;

    printer.alignCenter();
    printer.bold(true);
    printer.println('RESTAURANTE E PIZZARIA GABRYELLE - MUSIC & GASTRONOMIA');
    printer.println('COMANDA GERAL');
    printer.bold(false);
    printer.drawLine();
    printer.alignLeft();
    printer.bold(true);
    printer.println(`PEDIDO #${text(order.id)} - ${orderLocation(order).toUpperCase()}`);
    printer.bold(false);
    printer.println(`ATENDENTE: ${text(order.by, 'Não informado')}`);

    if (order.type === 'DELIVERY') {
        printer.println(`CLIENTE: ${text(order.cli || order.customer?.name)}`);
        printer.println(`TELEFONE: ${text(order.tel || order.customer?.phone)}`);
        printer.println(`ENDEREÇO: ${text(order.end || order.address)}`);
        printer.println(`BAIRRO: ${text(order.bairro || order.neighborhood)}`);
    }

    printer.drawLine();
    for (const item of items) {
        const quantity = Number(item.qty) || 0;
        const unitPrice = Number(item.price) || 0;
        const itemSubtotal = quantity * unitPrice;
        printer.println(`${quantity}x ${text(item.name, 'ITEM')}`);
        printer.println(`  ${money(unitPrice)} un.     Subtotal: ${money(itemSubtotal)}`);
        for (const detail of getItemDetails(item)) {
            printer.println(`  - ${detail}`);
        }
        if (item.obs) printer.println(`  OBS: ${text(item.obs)}`);
    }

    printer.drawLine();
    printer.leftRight('Subtotal', money(Number.isFinite(Number(order.sub)) ? order.sub : subtotal));
    printer.leftRight('Taxa de entrega', money(deliveryFee));
    printer.leftRight('Taxa de serviço', money(serviceFee));
    printer.bold(true);
    printer.leftRight('TOTAL GERAL', money(total));
    printer.bold(false);
    printer.println(`PAGAMENTO: ${text(order.pay || order.payPref, 'A receber')}`);
    printer.cut();
    await printer.execute();
    console.log(`🧾 Via do caixa impressa para o pedido #${text(order.id)}.`);
}

async function printOrder(order) {
    await printKitchenTicket(order);
    await printCashierTicket(order);
}

async function processLatestOrder() {
    const { data: row, error } = await supabase
        .from('app_state')
        .select('data')
        .eq('id', STATE_ID)
        .single();

    if (error) throw error;

    const state = row?.data;
    const orders = state?.orders;
    if (!Number.isSafeInteger(state?._revision)) {
        throw new Error('A proteção de sincronização do caixa não está disponível.');
    }
    if (!Array.isArray(orders) || orders.length === 0) return;

    const latestOrder = orders[orders.length - 1];
    if (!latestOrder || latestOrder.printedByService) return;
    if (latestOrder.status === 'CANCELADO') {
        console.log(`⏭️ Pedido #${text(latestOrder.id)} cancelado; impressão ignorada.`);
        return;
    }

    console.log(`🖨️ Iniciando impressão automática do pedido #${text(latestOrder.id)}.`);
    await printOrder(latestOrder);

    for (let attempt = 0; attempt < 5; attempt++) {
        const { data: latestRow, error: latestError } = await supabase
            .from('app_state')
            .select('data')
            .eq('id', STATE_ID)
            .single();
        if (latestError) throw latestError;
        const newData = latestRow?.data;
        if (!newData || !Array.isArray(newData.orders) || !Number.isSafeInteger(newData._revision)) {
            throw new Error('O estado atualizado não contém pedidos e revisão de sincronização válidos.');
        }
        const printedOrder = newData.orders.find(
            order => String(order.id) === String(latestOrder.id)
        );
        if (!printedOrder) throw new Error(`O pedido #${text(latestOrder.id)} não foi encontrado no estado atualizado.`);
        if (printedOrder.printedByService) return;
        printedOrder.printedByService = true;
        const { error: updateError } = await supabase
            .from('app_state')
            .update({ data: newData, updated_at: new Date().toISOString() })
            .eq('id', STATE_ID);
        if (!updateError) {
            console.log(`✅ Pedido #${text(latestOrder.id)} marcado como impresso no Supabase.`);
            return;
        }
        if (updateError.code !== '40001' || attempt === 4) throw updateError;
    }
}

let processingQueue = Promise.resolve();
function enqueueOrderProcessing() {
    processingQueue = processingQueue
        .then(processLatestOrder)
        .catch(error => {
            console.error('❌ Erro ao processar/imprimir pedido:', error);
        });
}

async function start() {
    if (!LEGACY_PRINT_SERVICE_ENABLED) {
        console.log('Serviço de impressão legado desativado. A impressão automática é realizada pelo Gabryelle Print Agent.');
        return;
    }

    console.log('🔌 Conectando ao Supabase Realtime...');

    const channel = supabase
        .channel('gabryelle-prime-app-state')
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'app_state',
                filter: `id=eq.${STATE_ID}`
            },
            () => {
                console.log('🔔 Alteração detectada em app_state.');
                enqueueOrderProcessing();
            }
        )
        .subscribe(status => {
            if (status === 'SUBSCRIBED') {
                console.log('✅ Serviço conectado e aguardando pedidos.');
                enqueueOrderProcessing();
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                console.error(`❌ Estado do canal Realtime: ${status}.`);
            }
        });

    const shutdown = async signal => {
        console.log(`🛑 ${signal} recebido; encerrando o canal Realtime.`);
        await supabase.removeChannel(channel);
        process.exit(0);
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch(error => {
    console.error('❌ Não foi possível iniciar o serviço de impressão:', error);
    process.exitCode = 1;
});