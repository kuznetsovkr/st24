import { Link, NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useUI } from '../context/UIContext.tsx';

type Props = {
  children: ReactNode;
};

const AppLayout = ({ children }: Props) => {
  const { cartCount } = useUI();

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `nav-link${isActive ? ' nav-link--active' : ''}`;

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
            <span className="cart-badge" aria-label={`Товаров в корзине: ${cartCount}`}>
              {cartCount}
            </span>
          </NavLink>
          <NavLink to="/b2b" className={navLinkClass}>
            Юр. лица
          </NavLink>
          <NavLink to="/about" className={navLinkClass}>
            О нас
          </NavLink>
        </nav>
      </header>
      <main className="app-main">{children}</main>
      <footer className="app-footer">
        <div className="footer-brand">
          <span className="logo">logo</span>
          <p>Простая заготовка интернет-магазина на React + Node.</p>
        </div>
        <div className="footer-links">
          <Link to="/privacy">Политика конфиденциальности</Link>
          <Link to="/terms">Пользовательское соглашение</Link>
        </div>
      </footer>
    </div>
  );
};

export default AppLayout;
