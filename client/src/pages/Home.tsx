import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { useUI } from '../context/UIContext.tsx';

const featuredProducts = [
  { id: 'featured-1', name: 'Фильтр насосный Pro-1', price: '12 900 руб.' },
  { id: 'featured-2', name: 'Редуктор привода S7', price: '18 500 руб.' },
  { id: 'featured-3', name: 'Подшипник усиленный M5', price: '3 200 руб.' },
  { id: 'featured-4', name: 'Панель управления 4.0', price: '24 900 руб.' },
  { id: 'featured-5', name: 'Сенсор температуры T-200', price: '5 400 руб.' },
  { id: 'featured-6', name: 'Смеситель бытовой Aqua', price: '6 700 руб.' },
  { id: 'featured-7', name: 'Насадка для кухни Flex', price: '2 300 руб.' },
  { id: 'featured-8', name: 'Пылесборник Compact', price: '1 150 руб.' },
  { id: 'featured-9', name: 'Фильтр угольный Home', price: '2 900 руб.' },
  { id: 'featured-10', name: 'Сушка для посуды Flow', price: '1 800 руб.' }
];

const HomePage = () => {
  const { openProductModal } = useUI();
  const sliderRef = useRef<HTMLDivElement | null>(null);

  const handleSlide = (direction: 'prev' | 'next') => {
    const track = sliderRef.current;

    if (!track) {
      return;
    }

    const scrollAmount = track.clientWidth;
    track.scrollBy({
      left: direction === 'next' ? scrollAmount : -scrollAmount,
      behavior: 'smooth'
    });
  };

  return (
    <div className="page">
      <div className="slider-header">
        <div>
          <p className="eyebrow">Главная</p>
          <h1>Слайдер товаров</h1>
          <p className="muted">Подборка для слайдера управляется вручную в админ-панели.</p>
        </div>
        <div className="slider-controls">
          <button className="slider-button" onClick={() => handleSlide('prev')}>
            Назад
          </button>
          <button className="slider-button slider-button--primary" onClick={() => handleSlide('next')}>
            Вперед
          </button>
        </div>
      </div>

      <div className="slider-track" ref={sliderRef}>
        {featuredProducts.map((product) => (
          <article key={product.id} className="slide">
            <div className="product-photo">
              <span>Фото</span>
            </div>
            <div className="product-info">
              <h3>{product.name}</h3>
              <p className="price">{product.price}</p>
              <button className="ghost-button" onClick={() => openProductModal(product.name)}>
                Подробнее
              </button>
            </div>
          </article>
        ))}
      </div>

      <div className="home-actions">
        <Link to="/catalog/prof-zapchasti" className="primary-button">
          Проф.запчасти
        </Link>
        <Link to="/catalog/bytovye" className="ghost-button">
          Бытовые
        </Link>
      </div>
    </div>
  );
};

export default HomePage;
