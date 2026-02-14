import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchCategories } from '../api';
import type { Category } from '../api';

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
    </div>
  );
};

export default CatalogPage;
