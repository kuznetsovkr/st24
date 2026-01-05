import { Link, useParams } from 'react-router-dom';
import { useUI } from '../context/UIContext.tsx';

const CategoryPage = () => {
  const { slug } = useParams<{ slug: string }>();
  const { openProductModal } = useUI();

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Раздел каталога</p>
          <h1>{slug ? `Категория: ${slug}` : 'Категория'}</h1>
          <p className="muted">
            Здесь появится список товаров для выбранной категории. Пока — заглушка и кнопка быстрого
            просмотра карточки.
          </p>
        </div>
        <Link to="/catalog" className="ghost-button">
          Назад в каталог
        </Link>
      </header>
      <div className="card">
        <h3>Пример товара</h3>
        <p className="muted">После подключения API здесь будет список позиций.</p>
        <div className="button-row">
          <button className="primary-button" onClick={() => openProductModal('Товар из категории')}>
            Открыть карточку
          </button>
          <Link to="/cart" className="text-button">
            Перейти к оформлению
          </Link>
        </div>
      </div>
    </div>
  );
};

export default CategoryPage;
