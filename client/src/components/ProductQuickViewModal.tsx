import { useUI } from '../context/UIContext.tsx';

const ProductQuickViewModal = () => {
  const { productModal, closeProductModal, incrementCart } = useUI();

  const handleAddToCart = () => {
    incrementCart();
  };

  if (!productModal.open) {
    return null;
  }

  return (
    <div className="modal-backdrop" onClick={closeProductModal}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">Быстрый просмотр</p>
            <h3>{productModal.productName ?? 'Карточка товара'}</h3>
          </div>
          <button className="icon-button" aria-label="Закрыть" onClick={closeProductModal}>
            x
          </button>
        </div>
        <p className="muted">
          Здесь появится краткое описание, фото и кнопки «Добавить в корзину / Купить в один клик».
        </p>
        <div className="modal-actions">
          <button className="primary-button" onClick={handleAddToCart}>
            Добавить в корзину
          </button>
          <button className="ghost-button" onClick={closeProductModal}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProductQuickViewModal;
