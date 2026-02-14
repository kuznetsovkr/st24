import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
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
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `nav-link${isActive ? ' nav-link--active' : ''}`;

  const handleLoginClick = () => {
    if (status === 'auth') {
      navigate('/account');
      return;
    }
    openAuthModal();
  };

  const handleToggleMenu = () => {
    setIsMenuOpen((prev) => !prev);
  };

  const handleCloseMenu = () => {
    setIsMenuOpen(false);
  };

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const isMenuTopState = isMenuOpen;
    const hasOverlayOpen = isMenuOpen;

    html.classList.toggle('ui-top-white', isMenuTopState);
    body.classList.toggle('ui-top-white', isMenuTopState);
    html.classList.toggle('ui-overlay-open', hasOverlayOpen);
    body.classList.toggle('ui-overlay-open', hasOverlayOpen);

    const metaTheme = document.querySelector('meta[name="theme-color"]');
    const themeColor = isMenuTopState ? '#ffffff' : '#f7f7f7';
    metaTheme?.setAttribute('content', themeColor);
  }, [isMenuOpen]);

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
          <NavLink to="/contacts" className={navLinkClass}>
            Контакты
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
          <button
            type="button"
            className="burger-button"
            onClick={handleToggleMenu}
            aria-label={isMenuOpen ? 'Закрыть меню' : 'Открыть меню'}
            aria-expanded={isMenuOpen}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="17" height="11" viewBox="0 0 17 11" fill="none">
              <path
                d="M0.5 0.5H16.5M0.5 5.5H16.5M0.5 10.5H16.5"
                stroke="#433F3C"
                strokeMiterlimit="10"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </header>
      <div
        className={`mobile-menu${isMenuOpen ? ' is-open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-hidden={!isMenuOpen}
      >
        <div className="mobile-menu-header">
          <button className="icon-button" aria-label="Закрыть" onClick={handleCloseMenu}>
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
        <nav className="mobile-menu-nav">
          <NavLink to="/catalog" className={navLinkClass} onClick={handleCloseMenu}>
            Каталог
          </NavLink>
          <NavLink to="/cart" className={navLinkClass} onClick={handleCloseMenu}>
            Корзина{' '}
            <span className="cart-badge" aria-label={`Товаров в корзине: ${totalCount}`}>
              {totalCount}
            </span>
          </NavLink>
          <NavLink to="/b2b" className={navLinkClass} onClick={handleCloseMenu}>
            Юр. лица
          </NavLink>
          <NavLink to="/contacts" className={navLinkClass} onClick={handleCloseMenu}>
            Контакты
          </NavLink>
          <button
            type="button"
            className="nav-link mobile-menu-account"
            onClick={() => {
              handleLoginClick();
              handleCloseMenu();
            }}
          >
            Личный кабинет
          </button>
        </nav>
      </div>
      <main className="app-main">{children}</main>
    </div>
  );
};

export default AppLayout;
