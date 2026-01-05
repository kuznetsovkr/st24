import { Link } from 'react-router-dom';

const mockCategories = [
  {
    slug: 'prof-zapchasti',
    title: 'Проф.запчасти',
    description: 'Оборудование, комплектующие и сервисные узлы'
  },
  {
    slug: 'bytovye',
    title: 'Бытовые',
    description: 'Товары для дома и компактные решения'
  }
];

const CatalogPage = () => {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Каталог</p>
          <h1>Разделы каталога</h1>
          <p className="muted">
            Заготовка для клиентской навигации. Категории можно заменить данными с бэка.
          </p>
        </div>
        <Link to="/cart" className="primary-button">
          Перейти в корзину
        </Link>
      </header>
      <div className="grid">
        {mockCategories.map((category) => (
          <article key={category.slug} className="card">
            <p className="eyebrow">{category.title}</p>
            <h3>{category.description}</h3>
            <Link to={`/catalog/${category.slug}`} className="text-button">
              Открыть раздел
            </Link>
          </article>
        ))}
      </div>
    </div>
  );
};

export default CatalogPage;
