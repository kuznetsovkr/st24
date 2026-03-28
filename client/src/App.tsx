import { Suspense, lazy } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import AppLayout from './layout/AppLayout.tsx';
import { AuthProvider } from './context/AuthContext.tsx';
import { CartProvider } from './context/CartContext.tsx';
import { UIProvider } from './context/UIContext.tsx';
import ProductQuickViewModal from './components/ProductQuickViewModal.tsx';
import AuthModal from './components/AuthModal.tsx';
import NeedPartModal from './components/NeedPartModal.tsx';

const ContactsPage = lazy(() => import('./pages/Contacts.tsx'));
const AboutPage = lazy(() => import('./pages/About.tsx'));
const AdminPage = lazy(() => import('./pages/Admin.tsx'));
const B2BPage = lazy(() => import('./pages/B2B.tsx'));
const CartPage = lazy(() => import('./pages/Cart.tsx'));
const CatalogPage = lazy(() => import('./pages/Catalog.tsx'));
const CategoryPage = lazy(() => import('./pages/Category.tsx'));
const HomePage = lazy(() => import('./pages/Home.tsx'));
const AccountPage = lazy(() => import('./pages/Account.tsx'));
const CheckoutPage = lazy(() => import('./pages/Checkout.tsx'));
const NotFoundPage = lazy(() => import('./pages/NotFound.tsx'));
const OrderSuccessPage = lazy(() => import('./pages/OrderSuccess.tsx'));
const PaymentPage = lazy(() => import('./pages/Payment.tsx'));
const SearchPage = lazy(() => import('./pages/Search.tsx'));
const PrivacyPage = lazy(() => import('./pages/Privacy.tsx'));
const TermsPage = lazy(() => import('./pages/Terms.tsx'));

const RouteLoader = () => (
  <div className="page">
    <p className="muted">{'Загружаем страницу...'}</p>
  </div>
);

const App = () => (
  <BrowserRouter>
    <AuthProvider>
      <CartProvider>
        <UIProvider>
          <AppLayout>
            <Suspense fallback={<RouteLoader />}>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/catalog" element={<CatalogPage />} />
                <Route path="/catalog/:slug" element={<CategoryPage />} />
                <Route path="/cart" element={<CartPage />} />
                <Route path="/checkout" element={<CheckoutPage />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/payment/:orderId" element={<PaymentPage />} />
                <Route path="/order-success/:orderId" element={<OrderSuccessPage />} />
                <Route path="/contacts" element={<ContactsPage />} />
                <Route path="/about" element={<AboutPage />} />
                <Route path="/b2b" element={<B2BPage />} />
                <Route path="/privacy" element={<PrivacyPage />} />
                <Route path="/terms" element={<TermsPage />} />
                <Route path="/account" element={<AccountPage />} />
                <Route path="/admin" element={<AdminPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </Suspense>
            <ProductQuickViewModal />
            <AuthModal />
            <NeedPartModal />
          </AppLayout>
        </UIProvider>
      </CartProvider>
    </AuthProvider>
  </BrowserRouter>
);

export default App;
