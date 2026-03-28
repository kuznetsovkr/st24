import { usePageSeo } from '../utils/usePageSeo.ts';

const PRIVACY_DOC_URL = '/docs/privacy-policy.pdf';

const PrivacyPage = () => {
  usePageSeo(
    'Политика обработки персональных данных | СТ-24',
    'Политика обработки персональных данных интернет-магазина СТ-24. Официальный текст документа доступен на странице и в PDF.'
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Юридическая информация</p>
          <h1>Политика обработки персональных данных</h1>
          <p className="muted">
            Ниже размещен официальный документ. Приоритет имеет полная версия в PDF.
          </p>
        </div>
      </header>

      <div className="card">
        <div className="legal-doc-actions">
          <a
            href={PRIVACY_DOC_URL}
            className="link-button legal-doc-download"
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть PDF в новой вкладке
          </a>
          <a href={PRIVACY_DOC_URL} className="link-button legal-doc-download" download>
            Скачать PDF
          </a>
        </div>

        <div className="legal-doc-viewer" aria-label="Просмотр политики обработки персональных данных">
          <iframe
            title="Политика обработки персональных данных"
            src={PRIVACY_DOC_URL}
            className="legal-doc-frame"
            loading="lazy"
          />
        </div>
      </div>
    </div>
  );
};

export default PrivacyPage;
