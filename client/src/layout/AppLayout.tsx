import { Link, NavLink, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';

type Props = {
  children: ReactNode;
};

const AppLayout = ({ children }: Props) => {
  const navigate = useNavigate();
  const { totalCount } = useCart();
  const { status } = useAuth();
  const { openAuthModal } = useUI();

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `nav-link${isActive ? ' nav-link--active' : ''}`;

  const handleLoginClick = () => {
    if (status === 'auth') {
      navigate('/account');
      return;
    }
    openAuthModal();
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link className="logo" to="/">
          logo
        </Link>
        <nav className="nav">
          <NavLink to="/catalog" className={navLinkClass}>
            Каталог
          </NavLink>
          <NavLink to="/cart" className={navLinkClass}>
            Корзина
            <span className="cart-badge" aria-label={`Товаров в корзине: ${totalCount}`}>
              {totalCount}
            </span>
          </NavLink>
          <NavLink to="/b2b" className={navLinkClass}>
            Юр. лица
          </NavLink>
          <NavLink to="/about" className={navLinkClass}>
            О нас
          </NavLink>
        </nav>
        <div className="header-actions">
          <button
            type="button"
            className="login-button"
            onClick={handleLoginClick}
            aria-label={status === 'auth' ? 'Личный кабинет' : 'Войти'}
          >
            <img src="/login.svg" alt="" aria-hidden="true" />
          </button>
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
};

export default AppLayout;
