import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import {
  clearAuthToken,
  createProduct,
  deleteProduct,
  fetchCategories,
  fetchMe,
  fetchProducts,
  getAuthToken,
  requestAuthCode,
  setAuthToken,
  updateProduct,
  verifyAuthCode
} from '../api';
import type { AuthUser, Category, Product } from '../api';
import {
  applyFontTheme,
  getStoredFontTheme,
  setStoredFontTheme,
  type FontTheme
} from '../utils/fontTheme';

const MAX_IMAGES = 5;

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });

const formatPriceInput = (priceCents: number) => {
  const value = (priceCents / 100).toFixed(2);
  return value.endsWith('.00') ? value.slice(0, -3) : value;
};

const formatPriceLabel = (priceCents: number) =>
  new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 2
  }).format(priceCents / 100);

const AdminPage = () => {
  const [authStatus, setAuthStatus] = useState<'checking' | 'guest' | 'auth'>('checking');
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<'code' | 'password'>('code');
  const [password, setPassword] = useState('');
  const [isSendingCode, setIsSendingCode] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [fontTheme, setFontTheme] = useState<FontTheme>(() => getStoredFontTheme());

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('table');

  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('0');
  const [category, setCategory] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [existingImages, setExistingImages] = useState<string[]>([]);
  const [newImages, setNewImages] = useState<File[]>([]);
  const [newPreviews, setNewPreviews] = useState<string[]>([]);
  const [showInSlider, setShowInSlider] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  const [sliderOrder, setSliderOrder] = useState('0');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    applyFontTheme(fontTheme);
  }, [fontTheme]);

  useEffect(() => {
    const token = getAuthToken();
    if (!token) {
      setAuthStatus('guest');
      return;
    }

    fetchMe()
      .then((user) => {
        setAuthUser(user);
        setAuthStatus('auth');
      })
      .catch(() => {
        clearAuthToken();
        setAuthStatus('guest');
      });
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [categoryItems, productItems] = await Promise.all([
        fetchCategories(),
        fetchProducts({ includeHidden: true })
      ]);
      setCategories(categoryItems);
      setProducts(productItems);
      setCategory((prev) => prev || categoryItems[0]?.slug || '');
      setIsLoading(false);
    } catch {
      setError('Не удалось загрузить данные.');
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (authStatus === 'auth' && authUser?.role === 'admin') {
      loadData();
    }
  }, [authStatus, authUser]);

  const resetForm = () => {
    setName('');
    setSku('');
    setDescription('');
    setPrice('');
    setStock('0');
    setEditingId(null);
    setExistingImages([]);
    setNewImages([]);
    setNewPreviews([]);
    setShowInSlider(false);
    setIsHidden(false);
    setSliderOrder('0');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleImagesChange = async (event: ChangeEvent<HTMLInputElement>) => {
    setStatus(null);
    setError(null);
    const files = Array.from(event.target.files ?? []);
    const limited = files.slice(0, MAX_IMAGES);
    if (files.length > MAX_IMAGES) {
      setError(`Можно выбрать максимум ${MAX_IMAGES} изображений.`);
    }

    try {
      const previews = await Promise.all(limited.map(readFileAsDataUrl));
      setNewImages(limited);
      setNewPreviews(previews);
    } catch {
      setError('Не удалось обработать изображения.');
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus(null);
    setError(null);

    if (!name.trim() || !sku.trim() || !price.trim() || stock.trim() === '' || !category) {
      setError('Заполните название, SKU, цену и категорию.');
      return;
    }

    setIsSubmitting(true);

    const formData = new FormData();
    formData.append('name', name.trim());
    formData.append('sku', sku.trim());
    formData.append('description', description.trim());
    formData.append('price', price.trim());
    formData.append('stock', stock.trim());
    formData.append('category', category);
    formData.append('showInSlider', showInSlider ? 'true' : 'false');
    formData.append('isHidden', isHidden ? 'true' : 'false');
    formData.append('sliderOrder', sliderOrder.trim() || '0');

    if (newImages.length > 0) {
      newImages.forEach((file) => formData.append('images', file));
      formData.append('replaceImages', 'true');
    }

    try {
      if (editingId) {
        const updated = await updateProduct(editingId, formData);
        setProducts((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        setStatus('Товар обновлен.');
      } else {
        const created = await createProduct(formData);
        setProducts((prev) => [created, ...prev]);
        setStatus('Товар добавлен.');
      }
      resetForm();
    } catch (submitError) {
      if (submitError instanceof Error) {
        setError(submitError.message);
      } else {
        setError('Не удалось сохранить товар.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = (product: Product) => {
    setEditingId(product.id);
    setName(product.name);
    setSku(product.sku);
    setDescription(product.description);
    setPrice(formatPriceInput(product.priceCents));
    setStock(String(product.stock ?? 0));
    setCategory(product.category);
    setExistingImages(product.images);
    setShowInSlider(product.showInSlider);
    setIsHidden(product.isHidden);
    setSliderOrder(String(product.sliderOrder ?? 0));
    setNewImages([]);
    setNewPreviews([]);
    setStatus(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (product: Product) => {
    const confirmed = window.confirm(`Удалить товар "${product.name}"?`);
    if (!confirmed) {
      return;
    }

    setError(null);
    setStatus(null);
    try {
      await deleteProduct(product.id);
      setProducts((prev) => prev.filter((item) => item.id !== product.id));
      if (editingId === product.id) {
        resetForm();
      }
      setStatus('Товар удален.');
    } catch {
      setError('Не удалось удалить товар.');
    }
  };

  const handleRequestCode = async () => {
    setAuthMessage(null);
    setError(null);
    if (!phone.trim()) {
      setAuthMessage('Введите номер телефона.');
      return;
    }

    setIsSendingCode(true);
    try {
      const result = await requestAuthCode(phone.trim());
      if (result.requiresPassword) {
        setAuthMode('password');
        setAuthMessage('Введите пароль администратора.');
        return;
      }
      setAuthMode('code');
      setAuthMessage('Код отправлен. Проверьте консоль сервера.');
    } catch {
      setAuthMessage('Не удалось отправить код.');
    } finally {
      setIsSendingCode(false);
    }
  };

  const handleFontThemeChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextTheme = event.target.value === 'franklin' ? 'franklin' : 'default';
    setFontTheme(nextTheme);
    setStoredFontTheme(nextTheme);
  };

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthMessage(null);
    if (!phone.trim()) {
      setAuthMessage('Введите номер телефона.');
      return;
    }
    if (authMode === 'password') {
      if (!password.trim()) {
        setAuthMessage('Введите пароль.');
        return;
      }
    } else if (!code.trim()) {
      setAuthMessage('Введите код.');
      return;
    }

    setIsVerifying(true);
    try {
      const result =
        authMode === 'password'
          ? await verifyAuthCode(phone.trim(), '', password.trim())
          : await verifyAuthCode(phone.trim(), code.trim());
      setAuthToken(result.token);
      setAuthUser(result.user);
      setAuthStatus('auth');
      setCode('');
      setPassword('');
      setAuthMessage(null);
    } catch {
      setAuthMessage(authMode === 'password' ? 'Неверный пароль.' : 'Неверный код.');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleLogout = () => {
    clearAuthToken();
    setAuthUser(null);
    setAuthStatus('guest');
  };

  if (authStatus === 'checking') {
    return (
      <div className="page">
        <p className="muted">Проверяем доступ...</p>
      </div>
    );
  }

  if (authStatus !== 'auth' || !authUser) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">Админ-панель</p>
            <h1>Вход по телефону</h1>
            <p className="muted">
              Отправим код в консоль сервера. Роль администратора выдаётся для номера
              +79964292550.
            </p>
          </div>
        </header>
        <div className="card">
          <form className="stacked-form" onSubmit={handleVerify}>
            <label className="field">
              <span>Телефон</span>
              <input
                type="tel"
                placeholder="+7"
                value={phone}
                onChange={(event) => {
                  setPhone(event.target.value);
                  setAuthMode('code');
                  setCode('');
                  setPassword('');
                }}
                required
              />
            </label>
            {authMode === 'code' && (
            <div className="button-row">
              <button
                type="button"
                className="ghost-button"
                onClick={handleRequestCode}
                disabled={isSendingCode}
              >
                {isSendingCode ? 'Отправляем...' : 'Получить код'}
              </button>
            </div>
            )}
            <label className="field">
              <span>{authMode === 'password' ? 'Пароль администратора' : 'Код из консоли'}</span>
              <input
                type={authMode === 'password' ? 'password' : 'text'}
                inputMode={authMode === 'password' ? undefined : 'numeric'}
                value={authMode === 'password' ? password : code}
                onChange={(event) =>
                  authMode === 'password'
                    ? setPassword(event.target.value)
                    : setCode(event.target.value)
                }
                required
              />
            </label>
            <button className="primary-button" type="submit" disabled={isVerifying}>
              {isVerifying ? 'Проверяем...' : 'Войти'}
            </button>
            {authMessage && <p className="status-text">{authMessage}</p>}
          </form>
        </div>
      </div>
    );
  }

  if (authUser.role !== 'admin') {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">Админ-панель</p>
            <h1>Недостаточно прав</h1>
            <p className="muted">Для доступа к админке нужен администраторский номер.</p>
          </div>
        </header>
        <div className="card">
          <button className="ghost-button" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Админ-панель</p>
          <h1>Управление товарами</h1>
          <p className="muted">Добавление, редактирование и удаление карточек.</p>
        </div>
        <button className="ghost-button" onClick={handleLogout}>
          Выйти
        </button>
      </header>
      <div className="card">
        <h3>Оформление шрифтов</h3>
        <div className="stacked-form">
          <label className="field">
            <span>Вариант оформления сайта</span>
            <select value={fontTheme} onChange={handleFontThemeChange}>
              <option value="default">Текущие шрифты</option>
              <option value="franklin">Franklin Gothic (новые)</option>
            </select>
            <span className="form-help">
              Применяется ко всем текущим страницам в этом браузере.
            </span>
          </label>
        </div>
      </div>
      <div className="card">
        <form className="admin-form" onSubmit={handleSubmit}>
          <div className="form-grid">
            <label className="field">
              <span>Название товара</span>
              <input
                type="text"
                placeholder="Например: Фильтр насосный Pro-1"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>SKU</span>
              <input
                type="text"
                placeholder="PRO-001"
                value={sku}
                onChange={(event) => setSku(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Цена (руб.)</span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="12900"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Остаток (шт.)</span>
              <input
                type="number"
                min="0"
                step="1"
                value={stock}
                onChange={(event) => setStock(event.target.value)}
                required
              />
            </label>

            <label className="field">
              <span>Категория</span>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                required
                disabled={isLoading}
              >
                <option value="" disabled>
                  Выберите категорию
                </option>
                {categories.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>Описание</span>
            <textarea
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Краткое описание товара"
            />
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={showInSlider}
              onChange={(event) => setShowInSlider(event.target.checked)}
            />
            <span>Отображать в слайдере на главной</span>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={isHidden}
              onChange={(event) => setIsHidden(event.target.checked)}
            />
            <span>Отключить отображение на сайте</span>
          </label>
          <label className="field">
            <span>Порядок в слайдере (меньше - выше)</span>
            <input
              type="number"
              min="0"
              step="1"
              value={sliderOrder}
              onChange={(event) => setSliderOrder(event.target.value)}
              disabled={!showInSlider}
            />
          </label>
          <label className="field">
            <span>Изображения (до {MAX_IMAGES})</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleImagesChange}
            />
            <span className="form-help">
              Изображения сохраняются в папку uploads на сервере.
            </span>
          </label>
          {existingImages.length > 0 && newPreviews.length === 0 && (
            <div>
              <p className="muted">Текущие изображения</p>
              <div className="image-preview">
                {existingImages.map((src) => (
                  <img key={src} src={src} alt="Изображение товара" />
                ))}
              </div>
            </div>
          )}
          {newPreviews.length > 0 && (
            <div>
              <p className="muted">
                Новые изображения (заменят текущие после сохранения)
              </p>
              <div className="image-preview">
                {newPreviews.map((src, index) => (
                  <img key={`${src}-${index}`} src={src} alt={`Изображение ${index + 1}`} />
                ))}
              </div>
            </div>
          )}
          {status && <p className="status-text">{status}</p>}
          {error && <p className="status-text status-text--error">{error}</p>}
          <div className="button-row">
            <button className="primary-button" type="submit" disabled={isSubmitting}>
              {isSubmitting
                ? 'Сохраняем...'
                : editingId
                ? 'Сохранить изменения'
                : 'Добавить товар'}
            </button>
            {editingId && (
              <button
                className="ghost-button"
                type="button"
                onClick={resetForm}
                disabled={isSubmitting}
              >
                Отменить
              </button>
            )}
          </div>
        </form>
      </div>

      <div className="card">
        <h3>Добавленные товары</h3>
        <div className="admin-view-toggle">
          <button
            type="button"
            className={`ghost-button${viewMode === 'grid' ? ' is-active' : ''}`}
            onClick={() => setViewMode('grid')}
          >
            Карточки
          </button>
          <button
            type="button"
            className={`ghost-button${viewMode === 'table' ? ' is-active' : ''}`}
            onClick={() => setViewMode('table')}
          >
            Список
          </button>
        </div>
        {isLoading && <p className="muted">Загрузка списка...</p>}
        {!isLoading && products.length === 0 && <p className="muted">Пока товаров нет.</p>}
        {!isLoading && products.length > 0 && (
          <>
            <div className={viewMode === 'grid' ? 'products-grid' : 'products-grid is-hidden'}>
              {products.map((product) => (
                <article key={product.id} className="product-card">
                  <div className="product-image">
                    {product.images[0] ? (
                      <img src={product.images[0]} alt={product.name} />
                    ) : (
                      <span>Фото</span>
                    )}
                  </div>
                  <div className="product-meta">
                    <h3>{product.name}</h3>
                    <p className="muted">SKU: {product.sku}</p>
                    <p className="price">{formatPriceLabel(product.priceCents)}</p>
                    <p className="stock-text">Остаток: {product.stock}</p>
                    {product.isHidden && (
                      <span className="status-badge status-badge--hidden">Скрыт</span>
                    )}
                    {product.description && <p className="muted">{product.description}</p>}
                    {product.showInSlider && (
                      <p className="eyebrow">В слайдере · {product.sliderOrder}</p>
                    )}
                  </div>
                  <div className="button-row">
                    <button className="ghost-button" onClick={() => handleEdit(product)}>
                      Редактировать
                    </button>
                    <button className="text-button" onClick={() => handleDelete(product)}>
                      Удалить
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <div className={viewMode === 'table' ? 'admin-table-wrap' : 'admin-table-wrap is-hidden'}>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Фото</th>
                    <th>Название</th>
                    <th>SKU</th>
                    <th>Цена</th>
                    <th>Остаток</th>
                    <th>Статус</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => (
                    <tr key={product.id}>
                      <td>
                        <div className="admin-table-thumb">
                          {product.images[0] ? (
                            <img src={product.images[0]} alt={product.name} />
                          ) : (
                            <span>Фото</span>
                          )}
                        </div>
                      </td>
                      <td>{product.name}</td>
                      <td className="muted">{product.sku}</td>
                      <td>{formatPriceLabel(product.priceCents)}</td>
                      <td>{product.stock}</td>
                      <td>
                        {product.isHidden ? (
                          <span className="status-badge status-badge--hidden">Скрыт</span>
                        ) : (
                          <span className="muted">Виден</span>
                        )}
                      </td>
                      <td>
                        <div className="admin-table-actions">
                          <button className="ghost-button" onClick={() => handleEdit(product)}>
                            Редактировать
                          </button>
                          <button className="text-button" onClick={() => handleDelete(product)}>
                            Удалить
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default AdminPage;
