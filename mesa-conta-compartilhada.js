(function (root) {
    function createMesaBill(mesaNumber, orders, adjustments = null, attendant = '') {
        const items = orders.flatMap(order => order.items || []);
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

    const mesa = { createMesaBill, previewSignature };
    root.GabryelleMesa = mesa;
    if (typeof module !== 'undefined' && module.exports) module.exports = mesa;
})(globalThis);
