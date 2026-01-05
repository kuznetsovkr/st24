const AdminPage = () => {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Админ-панель</p>
          <h1>Вход в админку</h1>
          <p className="muted">
            Стартовая точка для CMS/панели управления товарами, заказами и пользователями.
          </p>
        </div>
      </header>
      <div className="card">
        <h3>Что запланировать</h3>
        <ul className="list">
          <li>Авторизация админа и ролевая модель</li>
          <li>CRUD для категорий и товаров</li>
          <li>Мониторинг заказов и статусов оплат</li>
        </ul>
      </div>
    </div>
  );
};

export default AdminPage;
