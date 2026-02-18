import type { Product } from '../api';
import { formatPrice } from '../utils/formatPrice.ts';
import ProductImageSlider from './ProductImageSlider.tsx';
import QuantityStepIcon from './QuantityStepIcon.tsx';

type ProductMiniCardProps = {
  product: Product;
  quantity: number;
  isAdmin?: boolean;
  className?: string;
  onOpen: (product: Product) => void;
  onAddToCart: (product: Product) => void;
  onNeedPart: (product: Product) => void;
  onIncrement: (productId: string) => void;
  onDecrement: (productId: string) => void;
  onSetQuantity: (productId: string, quantity: number) => void;
};

const ProductMiniCard = ({
  product,
  quantity,
  isAdmin = false,
  className = 'slide slide--clickable',
  onOpen,
  onAddToCart,
  onNeedPart,
  onIncrement,
  onDecrement,
  onSetQuantity
}: ProductMiniCardProps) => {
  const isOutOfStock = product.stock === 0;

  return (
    <article className={className} onClick={() => onOpen(product)}>
      <ProductImageSlider className="product-photo" images={product.images} alt={product.name} />
      <div className="product-info">
        <h3>{product.name}</h3>
        <p className="price">{formatPrice(product.priceCents)}</p>
        {isAdmin && <p className="stock-text">Остаток: {product.stock}</p>}
        <div className="product-actions">
          <button
            className="ghost-button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen(product);
            }}
          >
            Подробнее
          </button>
          {quantity === 0 ? (
            isOutOfStock ? (
              <span className="stock-badge">Нет в наличии</span>
            ) : (
              <button
                className="primary-button"
                onClick={(event) => {
                  event.stopPropagation();
                  onAddToCart(product);
                }}
              >
                В корзину
              </button>
            )
          ) : (
            <div
              className="qty-control"
              role="group"
              onClick={(event) => event.stopPropagation()}
              aria-label="Количество товара"
            >
              <button
                type="button"
                className="qty-button"
                onClick={() => onDecrement(product.id)}
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
                  onSetQuantity(product.id, next);
                }}
              />
              <button
                type="button"
                className="qty-button"
                onClick={() => onIncrement(product.id)}
                aria-label="Увеличить количество"
                disabled={typeof product.stock === 'number' && quantity >= product.stock}
              >
                <QuantityStepIcon type="plus" />
              </button>
            </div>
          )}
          {isOutOfStock && (
            <button
              type="button"
              className="text-button need-help-link"
              onClick={(event) => {
                event.stopPropagation();
                onNeedPart(product);
              }}
            >
              Помогите, нужна деталь
            </button>
          )}
        </div>
      </div>
    </article>
  );
};

export default ProductMiniCard;
