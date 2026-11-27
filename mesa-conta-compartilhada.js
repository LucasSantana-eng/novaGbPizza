(function (root) {
    function groupItemLines(items) {
        const groups = new Map();
        items.forEach((item, index) => {
            const key = JSON.stringify([item.name, item.category || '', Number(item.price),
                item.det || [], item.obs || '']);
            const existing = groups.get(key);
            if (existing) {
                existing.item.qty += Number(item.qty);
                existing.indexes.push(index);
            } else groups.set(key, { item: { ...item, qty: Number(item.qty) }, indexes: [index] });
        });
        return [...groups.values()];
    }

    function groupItems(items) {
        return groupItemLines(items).map(group => group.item);
    }

    function consolidateTableOrders(orders, mesaNumber, rate, addition = null) {
        const selected = orders.filter(order => order.type === 'MESA' &&
            Number(order.mesa) === Number(mesaNumber) && !order.paid && order.status !== 'CANCELADO');
        if (!selected.length && !addition) throw new Error('Mesa sem pedidos em aberto.');
        if (!Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 100) {
            throw new Error('Taxa de serviço inválida.');
        }
        if (selected.some(order => Number(order.discount || 0) || Number(order.removedService || 0))) {
            throw new Error('A mesa possui ajustes anteriores. Confira a conta antes de unificar.');
        }
        const primary = selected[0] || addition;
        const result = { ...primary, items: [], tableBatches: [], tableOriginalOrders: [] };
        const serviceEnabled = selected.length
            ? selected.some(order => order.serviceEnabled === true || (order.serviceEnabled !== false && Number(order.svc) > 0))
            : addition.serviceEnabled;
        let taxa = 0;
        for (const order of selected) {
            taxa += Number(order.taxa || 0);
            if (Array.isArray(order.tableBatches)) {
                result.items.push(...order.items.map(item => ({ ...item })));
                result.tableBatches.push(...order.tableBatches.map(batch => ({ ...batch })));
                result.tableOriginalOrders.push(...(order.tableOriginalOrders || []));
            } else {
                const batchId = `legacy-${order.id}`;
                result.tableOriginalOrders.push({ ...order });
                result.items.push(...order.items.map(item => ({ ...item, tableBatchId: batchId })));
                result.tableBatches.push({
                    id: batchId, at: order.at, by: order.by, status: order.status,
                    items: order.items.map(item => ({ ...item })), printRequested: false
                });
            }
        }
        if (addition) {
            const batch = addition.tableBatches[0];
            result.items.push(...addition.items.map(item => ({ ...item, tableBatchId: batch.id })));
            result.tableBatches.push(batch);
            taxa += Number(addition.taxa || 0);
        }
        result.serviceEnabled = !!serviceEnabled;
        result.svcPct = Number(rate);
        result.sub = +(result.items.reduce((sum, item) => sum + Number(item.qty) * Number(item.price), 0)).toFixed(2);
        result.svc = serviceEnabled ? Math.round(Math.round(result.sub * 100) * result.svcPct / 100 + 1e-8) / 100 : 0;
        result.taxa = +taxa.toFixed(2);
        result.total = +(result.sub + result.taxa + result.svc).toFixed(2);
        result.status = result.tableBatches.some(batch => batch.status === 'PENDENTE' &&
            result.items.some(item => item.tableBatchId === batch.id)) ? 'PENDENTE' : 'PRONTO';
        return result;
    }

    function attendantShares(order, amount) {
        const weights = new Map();
        const batches = new Map((order.tableBatches || []).map(batch => [batch.id, batch.by]));
        for (const item of order.items || []) {
            const name = batches.get(item.tableBatchId) || order.by || 'Não informado';
            weights.set(name, (weights.get(name) || 0) + Math.round(Number(item.qty) * Number(item.price) * 100));
        }
        const totalWeight = [...weights.values()].reduce((sum, value) => sum + value, 0);
        const cents = Math.round(Number(amount) * 100);
        if (totalWeight <= 0) return [{ name: order.by || 'Não informado', amount }];
        const shares = [...weights].map(([name, weight]) => {
            const exact = cents * weight / totalWeight;
            return { name, cents: Math.floor(exact), fraction: exact - Math.floor(exact) };
        });
        let remaining = cents - shares.reduce((sum, share) => sum + share.cents, 0);
        for (const share of [...shares].sort((a, b) => b.fraction - a.fraction)) {
            if (remaining-- <= 0) break;
            share.cents++;
        }
        return shares.map(share => ({ name: share.name, amount: share.cents / 100 }));
    }

    function createMesaBill(mesaNumber, orders, adjustments = null, attendant = '') {
        const items = groupItems(orders.flatMap(order => order.items || []));
        const subtotal = +orders.reduce((sum, order) => sum + Number(order.sub ??
            (order.items || []).reduce((itemSum, item) => itemSum + (Number(item.qty) || 0) * (Number(item.price) || 0), 0)), 0).toFixed(2);
        const taxa = +orders.reduce((sum, order) => sum + Number(order.taxa || 0), 0).toFixed(2);
        const service = +orders.reduce((sum, order) => sum + Number(order.svc || 0), 0).toFixed(2);
        return {
            ...orders[0],
            id: orders[0].id,
            at: Date.now(),
            mesa: mesaNumber,
            items,
            sub: subtotal,
            taxa,
            svc: adjustments?.removeService ? 0 : service,
            removedService: adjustments?.removeService ? service : 0,
            discount: adjustments ? adjustments.discounts.reduce((sum, value) => sum + value, 0) / 100 : 0,
            total: adjustments ? adjustments.totalCents / 100 : +orders.reduce((sum, order) => sum + Number(order.total || 0), 0).toFixed(2),
            paid: false,
            pay: '',
            accountPreview: true,
            orderRefs: orders.map(order => `#${order.id}`).join(' • '),
            by: attendant || orders[0].by || ''
        };
    }

    function previewSignature(bill) {
        return JSON.stringify([bill.mesa, bill.orderRefs, bill.items, bill.sub, bill.taxa, bill.svc, bill.discount, bill.total]);
    }

    const mesa = { createMesaBill, previewSignature, groupItems, groupItemLines, consolidateTableOrders, attendantShares };
    root.GabryelleMesa = mesa;
    if (typeof module !== 'undefined' && module.exports) module.exports = mesa;
})(globalThis);
