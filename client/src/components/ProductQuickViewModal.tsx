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

  const quantity = getQuantity(product.id);
  const isOutOfStock = product.stock === 0;

  const handleAddToCart = () => {
    addItem({
      id: product.id,
      name: product.name,
      priceCents: product.priceCents,
      image: product.image,
      stock: product.stock
    });
  };

  return (
    <div className="modal-backdrop" onClick={closeProductModal}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">Быстрый просмотр</p>
            <h3>{product.name}</h3>
          </div>
          <button className="icon-button" aria-label="Закрыть" onClick={closeProductModal}>
            x
          </button>
        </div>
        {product.image && (
          <div className="modal-image">
            <img src={product.image} alt={product.name} />
          </div>
        )}
        {product.sku && <p className="muted">SKU: {product.sku}</p>}
        <p className="price">{formatPrice(product.priceCents)}</p>
        <p className="muted">
          {product.description ??
            'Описание появится позже. Добавьте товар в админ-панели и заполните подробности.'}
        </p>
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
                -
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
                +
              </button>
            </div>
          )}
          <button className="ghost-button" onClick={closeProductModal}>
            Закрыть
          </button>
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
