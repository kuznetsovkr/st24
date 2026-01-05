import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPrice } from '../utils/formatPrice.ts';

const ProductQuickViewModal = () => {
  const { productModal, closeProductModal } = useUI();
  const { addItem, decrement, getQuantity, increment } = useCart();
  const product = productModal.product;

  if (!productModal.open || !product) {
    return null;
  }

  const quantity = getQuantity(product.id);

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
            <button className="primary-button" onClick={handleAddToCart}>
              Добавить в корзину
            </button>
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
              <span className="qty-value">{quantity}</span>
              <button
                type="button"
                className="qty-button"
                onClick={() => increment(product.id)}
                aria-label="Увеличить количество"
              >
                +
              </button>
            </div>
          )}
          <button className="ghost-button" onClick={closeProductModal}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProductQuickViewModal;
