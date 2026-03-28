import { usePageSeo } from '../utils/usePageSeo.ts';

const TERMS_DOC_URL = '/docs/public-offer.pdf';

const TermsPage = () => {
  usePageSeo(
    'Публичная оферта | СТ-24',
    'Публичная оферта интернет-магазина СТ-24. Официальный текст документа доступен на странице и в PDF.'
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Юридическая информация</p>
          <h1>Публичная оферта</h1>
          <p className="muted">
            Ниже размещен официальный документ. Приоритет имеет полная версия в PDF.
          </p>
        </div>
      </header>

      <div className="card">
        <div className="legal-doc-actions">
          <a
            href={TERMS_DOC_URL}
            className="link-button legal-doc-download"
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть PDF в новой вкладке
          </a>
          <a href={TERMS_DOC_URL} className="link-button legal-doc-download" download>
            Скачать PDF
          </a>
        </div>

        <div className="legal-doc-viewer" aria-label="Просмотр публичной оферты">
          <iframe title="Публичная оферта" src={TERMS_DOC_URL} className="legal-doc-frame" loading="lazy" />
        </div>
      </div>
    </div>
  );
};

export default TermsPage;
