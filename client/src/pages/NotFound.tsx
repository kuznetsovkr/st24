import { Link } from 'react-router-dom';
import { usePageSeo } from '../utils/usePageSeo.ts';

const NotFoundPage = () => {
  usePageSeo('Страница не найдена | СТ-24', 'Запрошенная страница не найдена.', {
    robots: 'noindex,nofollow'
  });

  return (
    <div className="page page--center">
      <div className="card">
        <p className="eyebrow">404</p>
        <h1>Страница не найдена</h1>
        <p className="muted">Проверьте адрес или вернитесь на главную.</p>
        <div className="button-row">
          <Link to="/" className="primary-button">
            На главную
          </Link>
          <Link to="/catalog" className="ghost-button">
            В каталог
          </Link>
        </div>
      </div>
    </div>
  );
};

export default NotFoundPage;
