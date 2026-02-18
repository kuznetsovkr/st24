import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchCategories, fetchProducts } from '../api';
import type { Product } from '../api';
import ProductMiniCard from '../components/ProductMiniCard.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';

const CategoryPage = () => {
  const { slug } = useParams<{ slug: string }>();
  const { openProductModal, openNeedPartModal } = useUI();
  const { addItem, decrement, getQuantity, increment, setQuantity } = useCart();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [products, setProducts] = useState<Product[]>([]);
  const [categoryTitle, setCategoryTitle] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (!slug) {
      setStatus('error');
      setCategoryTitle('');
      return;
    }

    let active = true;

    const load = async () => {
      try {
        setStatus('loading');
        const [items, categories] = await Promise.all([
          fetchProducts({ category: slug }),
          fetchCategories().catch(() => [])
        ]);
        if (!active) {
          return;
        }
        setProducts(items);
        const matchedCategory = categories.find((category) => category.slug === slug);
        setCategoryTitle(matchedCategory?.name ?? slug);
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
  }, [slug]);

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
      <header className="page-header">
        <div>
          <p className="eyebrow">Раздел каталога</p>
          <h1>{slug ? `${categoryTitle || slug}` : 'Категория'}</h1>
          <p className="muted">Выберите товар и добавьте его в корзину.</p>
        </div>
        <Link to="/catalog" className="ghost-button">
          Назад к каталогу
        </Link>
      </header>
      {status === 'loading' && <p className="muted">Загружаем товары...</p>}
      {status === 'error' && <p className="muted">Не удалось загрузить товары.</p>}
      {status === 'ready' && products.length === 0 && (
        <div className="card">
          <h3>В этом разделе пока нет товаров</h3>
          <p className="muted">Добавьте позиции в админке, и они появятся здесь.</p>
          <Link to="/admin" className="primary-button">
            Перейти в админку
          </Link>
        </div>
      )}
      {status === 'ready' && products.length > 0 && (
        <div className="products-grid">
          {products.map((product) => (
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
    </div>
  );
};

export default CategoryPage;
