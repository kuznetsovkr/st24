import ProductImageSlider from './ProductImageSlider.tsx';
import QuantityStepIcon from './QuantityStepIcon.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPrice } from '../utils/formatPrice.ts';

const ProductQuickViewModal = () => {
  const { productModal, closeProductModal, openNeedPartModal } = useUI();
  const { addItem, decrement, getQuantity, increment, setQuantity } = useCart();
  const product = productModal.product;

  if (!productModal.open || !product) {
    return null;
  }

  const images = product.images?.length
    ? product.images
    : product.image
      ? [product.image]
      : [];
  const previewImage = images[0];

  const quantity = getQuantity(product.id);
  const isOutOfStock = product.stock === 0;

  const handleAddToCart = () => {
    addItem({
      id: product.id,
      name: product.name,
      priceCents: product.priceCents,
      image: previewImage,
      stock: product.stock,
      weightGrams: product.weightGrams,
      lengthCm: product.lengthCm,
      widthCm: product.widthCm,
      heightCm: product.heightCm
    });
  };

  return (
    <div className="modal-backdrop" onClick={closeProductModal}>
      <div className="modal-card modal-card--product" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>{product.name}</h3>
          </div>
          <button className="icon-button" aria-label="Закрыть" onClick={closeProductModal}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="17"
              height="17"
              viewBox="0 0 17 17"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M16.5 0.5L0.5 16.5M16.5 16.5L0.5 0.5"
                stroke="#433F3C"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <div className="modal-product-layout">
          <ProductImageSlider className="modal-image" images={images} alt={product.name} reserveControlsSpace={false} />

          <div className="modal-product-content">
            <div className="modal-product-block">
              <p className="modal-block-title">Характеристики</p>
              <ul className="modal-specs-list">
                <li>Вес: {product.weightGrams ? `${product.weightGrams} г` : '—'}</li>
                <li>
                  Габариты: {product.lengthCm ?? '—'} x {product.widthCm ?? '—'} x{' '}
                  {product.heightCm ?? '—'} см
                </li>
              </ul>
            </div>

            <div className="modal-product-block">
              <p className="modal-block-title">SKU</p>
              <p className="muted">{product.sku || '—'}</p>
            </div>

            <div className="modal-product-block">
              <p className="modal-block-title">Описание</p>
              <p className="muted">
                {product.description ??
                  'Описание появится позже. Добавьте товар в админ-панели и заполните подробности.'}
              </p>
            </div>

            <div className="modal-product-block">
              <p className="modal-block-title">Цена</p>
              <p className="price">{formatPrice(product.priceCents)}</p>
            </div>
          </div>
        </div>

        <div className="modal-actions">
          {quantity === 0 ? (
            isOutOfStock ? (
              <span className="stock-badge">Нет в наличии</span>
            ) : (
              <button className="primary-button" onClick={handleAddToCart}>
                Добавить в корзину
              </button>
            )
          ) : (
            <div className="qty-control" role="group" aria-label="Количество товара">
              <button
                type="button"
                className="qty-button"
                onClick={() => decrement(product.id)}
                aria-label="Уменьшить количество"
              >
                <QuantityStepIcon type="minus" />
              </button>
              <input
                className="qty-input"
                type="number"
                min="1"
                inputMode="numeric"
                value={quantity}
                onChange={(event) => {
                  const rawValue = event.target.value;
                  if (rawValue === '') {
                    return;
                  }
                  const next = Number.parseInt(rawValue, 10);
                  if (Number.isNaN(next)) {
                    return;
                  }
                  setQuantity(product.id, next);
                }}
              />
              <button
                type="button"
                className="qty-button"
                onClick={() => increment(product.id)}
                aria-label="Увеличить количество"
                disabled={typeof product.stock === 'number' && quantity >= product.stock}
              >
                <QuantityStepIcon type="plus" />
              </button>
            </div>
          )}
        </div>

        {isOutOfStock && (
          <button
            type="button"
            className="text-button need-help-link"
            onClick={() => openNeedPartModal(product)}
          >
            Помогите, нужна деталь
          </button>
        )}
      </div>
    </div>
  );
};

export default ProductQuickViewModal;
