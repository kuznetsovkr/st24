const CartPage = () => {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Корзина и оформление</p>
          <h1>Корзина</h1>
          <p className="muted">
            Страница для управления товарами, расчета доставки и оплаты. Пока — заглушка без
            интеграции с бэком.
          </p>
        </div>
      </header>
      <div className="card">
        <h3>Здесь будет список товаров в корзине</h3>
        <p className="muted">Добавим форму адреса, оплаты и проверку промокодов.</p>
      </div>
    </div>
  );
};

export default CartPage;
