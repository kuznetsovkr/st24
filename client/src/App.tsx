import { BrowserRouter, Route, Routes } from 'react-router-dom';
import AppLayout from './layout/AppLayout.tsx';
import AboutPage from './pages/About.tsx';
import AdminPage from './pages/Admin.tsx';
import B2BPage from './pages/B2B.tsx';
import CartPage from './pages/Cart.tsx';
import CatalogPage from './pages/Catalog.tsx';
import CategoryPage from './pages/Category.tsx';
import HomePage from './pages/Home.tsx';
import AccountPage from './pages/Account.tsx';
import CheckoutPage from './pages/Checkout.tsx';
import NotFoundPage from './pages/NotFound.tsx';
import OrderSuccessPage from './pages/OrderSuccess.tsx';
import PaymentPage from './pages/Payment.tsx';
import PrivacyPage from './pages/Privacy.tsx';
import TermsPage from './pages/Terms.tsx';
import { AuthProvider } from './context/AuthContext.tsx';
import { CartProvider } from './context/CartContext.tsx';
import { UIProvider } from './context/UIContext.tsx';
import ProductQuickViewModal from './components/ProductQuickViewModal.tsx';
import AuthModal from './components/AuthModal.tsx';

const App = () => (
  <BrowserRouter>
    <AuthProvider>
      <CartProvider>
        <UIProvider>
          <AppLayout>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/catalog" element={<CatalogPage />} />
              <Route path="/catalog/:slug" element={<CategoryPage />} />
              <Route path="/cart" element={<CartPage />} />
              <Route path="/checkout" element={<CheckoutPage />} />
              <Route path="/payment/:orderId" element={<PaymentPage />} />
              <Route path="/order-success/:orderId" element={<OrderSuccessPage />} />
              <Route path="/about" element={<AboutPage />} />
              <Route path="/b2b" element={<B2BPage />} />
              <Route path="/privacy" element={<PrivacyPage />} />
              <Route path="/terms" element={<TermsPage />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
            <ProductQuickViewModal />
            <AuthModal />
          </AppLayout>
        </UIProvider>
      </CartProvider>
    </AuthProvider>
  </BrowserRouter>
);

export default App;
