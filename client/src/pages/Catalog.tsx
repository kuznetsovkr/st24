import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchCategories } from '../api';
import type { Category } from '../api';

const CatalogCartIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M11.5,12h1v8h-1V12Zm5.5,8h1V12h-1v8Zm-11,0h1V12h-1v8ZM23.976,8l-1.844,13.831c-.166,1.236-1.231,2.169-2.479,2.169H4.338c-1.249,0-2.313-.933-2.479-2.17L.016,8H3.059C3.558,3.507,7.375,0,12,0s8.442,3.507,8.941,8h3.035Zm-19.906,0h15.861c-.495-3.94-3.859-7-7.931-7s-7.436,3.06-7.931,7Zm18.764,1H1.158l1.693,12.698c.098,.742,.737,1.302,1.486,1.302h15.314c.749,0,1.389-.56,1.488-1.302l1.692-12.698Z" />
  </svg>
);

const CatalogPage = () => {
  const [categories, setCategories] = useState<Category[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const items = await fetchCategories();
        if (!active) {
          return;
        }
        setCategories(items);
        setStatus('ready');
      } catch {
        if (active) {
          setStatus('error');
        }
      }
    };

    load();

    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Каталог</p>
          <h1>Разделы каталога</h1>
        </div>
      </header>
      {status === 'loading' && <p className="muted">Загрузка категорий...</p>}
      {status === 'error' && <p className="muted">Не удалось загрузить категории.</p>}
      {status === 'ready' && (
        <div className="category-grid">
          {categories.map((category) => (
            <Link key={category.slug} to={`/catalog/${category.slug}`} className="card category-card">
              <h3>{category.name}</h3>
              <div className="category-image">
                <span>Фото</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      <Link to="/cart" className="catalog-cart-fab" aria-label="Перейти в корзину">
        <span className="catalog-cart-fab-icon">
          <CatalogCartIcon />
        </span>
      </Link>
    </div>
  );
};

export default CatalogPage;
