const B2BPage = () => {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Для юридических лиц</p>
          <h1>B2B заявка</h1>
          <p className="muted">
            Маршрут /b2b зарезервирован под форму для юр. лиц и выставление счетов.
          </p>
        </div>
      </header>
      <div className="card">
        <h3>Шаги по доработке</h3>
        <ul className="list">
          <li>Форма реквизитов компании</li>
          <li>Загрузка документов / КП</li>
          <li>Интеграция с CRM или почтой для заявок</li>
        </ul>
      </div>
    </div>
  );
};

export default B2BPage;
