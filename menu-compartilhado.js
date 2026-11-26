(function (root) {
    const SIZES = ['Pequena', 'Média', 'Grande', 'Família'];
    const PZ = [
        ['Aeroporto','Mussarela, alho desidratado, champignon e tomate rodela'],['A Moda','Mussarela, ovo, frango, milho e bacon'],
        ['Americana','Milho, bacon, cebola e mussarela'],['Argentina','Mussarela, tomate, parmesão e azeitona'],
        ['Atum','Mussarela e atum'],['Bacalhau','Bacalhau, mussarela e azeitona'],
        ['Brasileira','Mussarela, atum, azeitona, cebola e milho'],['Bacon','Mussarela e bacon'],
        ['Bauru','Mussarela, presunto e rodelas de tomate'],['Calabresa','Mussarela e calabresa'],
        ['Calabresa Acebolada','Mussarela, calabresa e cebola'],['Calamito','Calabresa, palmito, milho, mussarela e catupiry'],
        ['Camarão','Azeitona, mussarela, cebola e camarão'],['Carioca','Mussarela, calabresa, bacon, catupiry e cebola'],
        ['Catupiry','Mussarela e catupiry'],['Espanhola','Presunto, calabresa, palmito, azeitona, tomate e mussarela'],
        ['Estrogonofe de Frango','Mussarela, frango em cubos, milho, creme de leite e batata palha'],['Frango','Mussarela e frango'],
        ['Frango com Catupiry','Mussarela, frango e catupiry'],['Gabryelle','Mussarela, frango, creme de leite e milho'],
        ['Lombinho','Mussarela e lombinho'],['Lombinho com Catupiry','Mussarela, lombinho e catupiry'],
        ['Mexicana','Carne moída, pimenta desidratada, calabresa, tomate e mussarela'],['Milho','Mussarela e milho'],
        ['Mussarela','Mussarela, tomate e cebola'],['Napolitana','Mussarela, palmito, milho, azeitona e presunto'],
        ['Nordestina','Mussarela, carne seca, cebola e banana'],['Presunto','Mussarela e presunto'],
        ['Palmito','Mussarela e palmito'],['Paulistinha','Frango desfiado, bacon e cheddar'],
        ['Peito de Peru','Mussarela e peito de peru'],['Peito de Peru com Catupiry','Mussarela, peito de peru e catupiry'],
        ['Portuguesa','Mussarela, presunto, palmito, ovo e azeitona'],['Quatro Queijos','Mussarela, gorgonzola, provolone e catupiry'],
        ['Romana','Mussarela, calabresa, ovo, presunto e azeitona'],['Salaminho','Mussarela, salame e azeitona'],
        ['Siciliana','Bacon, azeitona, cebola, mussarela e champignon'],['Suprema','Mussarela, carne desfiada, catupiry e barbecue'],
        ['Texas','Mussarela, frango, bacon e molho barbecue'],['Tomate Seco','Tomate seco e catupiry'],
        ['Tropically','Frango, abacaxi, mussarela e milho']
    ];
    const DOCE = [
        ['Banana','Mussarela, banana, canela em pó e catupiry'],['Brigadeiro','Chocolate, granulado e mussarela'],
        ['Nutella','Nutella, banana e mussarela'],['Romeu e Julieta','Goiabada, mussarela e creme de leite']
    ];

    function promotionPrice(menu, key, regularPrice, day = new Date().getDay()) {
        const promo = Number(menu.promoPrices[key]);
        const isPromotionDay = menu.promotionDays.includes(day);
        return isPromotionDay && Number.isFinite(promo) && promo >= 0 && regularPrice > 0 && promo < regularPrice
            ? promo : regularPrice;
    }

    function menuItems(menu, day = new Date().getDay()) {
        const out = [];
        PZ.forEach(p => out.push({ c: 'Pizzas', n: 'Pizza ' + p[0], f: p[0], d: p[1], pz: 0 }));
        DOCE.forEach(p => out.push({ c: 'Pizzas Doces', n: 'Pizza ' + p[0], f: p[0], d: p[1], pz: 1 }));
        Object.keys(menu.cats).forEach((category, categoryIndex) => menu.cats[category].forEach((item, itemIndex) => {
            const key = `item:${categoryIndex}:${itemIndex}`;
            out.push({ c: category, n: item[0], d: item[2], p: promotionPrice(menu, key, item[1], day), regularPrice: item[1], key });
        }));
        menu.customItems.forEach(item => {
            out.push({
                c: item.category,
                n: item.name,
                d: item.description || '',
                p: promotionPrice(menu, `custom:${item.id}`, item.price, day),
                regularPrice: item.price,
                key: `custom:${item.id}`
            });
        });
        return out;
    }

    const menu = { SIZES, PZ, DOCE, promotionPrice, menuItems };
    root.GabryelleMenu = menu;
    if (typeof module !== 'undefined' && module.exports) module.exports = menu;
})(globalThis);
