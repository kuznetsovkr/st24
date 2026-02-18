import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchProducts } from '../api';
import type { Product } from '../api';
import ProductMiniCard from '../components/ProductMiniCard.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';

const HomePage = () => {
  const { openProductModal, openNeedPartModal } = useUI();
  const { addItem, decrement, getQuantity, increment, setQuantity } = useCart();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const [featuredProducts, setFeaturedProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const items = await fetchProducts({ featured: true });
        if (!active) {
          return;
        }
        setFeaturedProducts(items);
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

  const handleSlide = (direction: 'prev' | 'next') => {
    const track = sliderRef.current;

    if (!track) {
      return;
    }

    const firstCard = track.querySelector<HTMLElement>('.slide');
    const styles = window.getComputedStyle(track);
    const gapValue = styles.columnGap || styles.gap || '0';
    const gap = Number.parseFloat(gapValue) || 0;
    const cardWidth = firstCard?.getBoundingClientRect().width ?? track.clientWidth;
    const scrollAmount = cardWidth + gap;
    track.scrollBy({
      left: direction === 'next' ? scrollAmount : -scrollAmount,
      behavior: 'smooth'
    });
  };

  const handleAddToCart = (product: Product) => {
    addItem({
      id: product.id,
      name: product.name,
      priceCents: product.priceCents,
      image: product.images[0],
      stock: product.stock,
      weightGrams: product.weightGrams,
      lengthCm: product.lengthCm,
      widthCm: product.widthCm,
      heightCm: product.heightCm
    });
  };

  const handleOpenProduct = (product: Product) => {
    openProductModal({
      id: product.id,
      name: product.name,
      priceCents: product.priceCents,
      description: product.description,
      sku: product.sku,
      image: product.images[0],
      images: product.images,
      weightGrams: product.weightGrams,
      lengthCm: product.lengthCm,
      widthCm: product.widthCm,
      heightCm: product.heightCm,
      stock: product.stock
    });
  };

  const handleNeedPart = (product: Product) => {
    openNeedPartModal({
      id: product.id,
      name: product.name,
      priceCents: product.priceCents,
      description: product.description,
      sku: product.sku,
      image: product.images[0],
      images: product.images,
      weightGrams: product.weightGrams,
      lengthCm: product.lengthCm,
      widthCm: product.widthCm,
      heightCm: product.heightCm,
      stock: product.stock
    });
  };

  return (
    <div className="page">
      <div className="slider-header">
        <div>
          <h1>Подборка товаров</h1>
        </div>
        <div className="slider-controls">
          <button className="slider-button" onClick={() => handleSlide('prev')}>
            Назад
          </button>
          <button className="slider-button slider-button--primary" onClick={() => handleSlide('next')}>
            Вперёд
          </button>
        </div>
      </div>

      {status === 'loading' && <p className="muted">Загружаем товары...</p>}
      {status === 'error' && <p className="muted">Не получилось загрузить товары.</p>}
      {status === 'ready' && featuredProducts.length === 0 && (
        <p className="muted">Пока нет товаров для слайдера. Отметьте товары в админке.</p>
      )}
      {status === 'ready' && featuredProducts.length > 0 && (
        <div className="slider-track" ref={sliderRef}>
          {featuredProducts.map((product) => (
            <ProductMiniCard
              key={product.id}
              product={product}
              quantity={getQuantity(product.id)}
              isAdmin={isAdmin}
              onOpen={handleOpenProduct}
              onAddToCart={handleAddToCart}
              onNeedPart={handleNeedPart}
              onDecrement={decrement}
              onIncrement={increment}
              onSetQuantity={setQuantity}
            />
          ))}
        </div>
      )}

      <div className="home-actions">
        <Link to="/catalog/prof-zapchasti" className="primary-button">
          Проф. запчасти
        </Link>
        <Link to="/catalog/bytovye" className="ghost-button">
          Бытовые
        </Link>
      </div>
    </div>
  );
};

export default HomePage;
