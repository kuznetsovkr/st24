import { usePageSeo } from '../utils/usePageSeo.ts';

const CONSENT_DOC_FILE = 'Согласие_на_опработку_перс_данных.pdf';
const CONSENT_DOC_URL = `/docs/${encodeURIComponent(CONSENT_DOC_FILE)}`;

const ConsentPage = () => {
  usePageSeo(
    'Согласие на обработку персональных данных | СТ-24',
    'Текст согласия на обработку персональных данных для пользователей интернет-магазина СТ-24.'
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Юридическая информация</p>
          <h1>Согласие на обработку персональных данных</h1>
          <p className="muted">
            Ниже размещен документ согласия, применяемый в формах сайта.
          </p>
        </div>
      </header>

      <div className="card">
        <div className="legal-doc-actions">
          <a
            href={CONSENT_DOC_URL}
            className="link-button legal-doc-download"
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть PDF в новой вкладке
          </a>
          <a href={CONSENT_DOC_URL} className="link-button legal-doc-download" download>
            Скачать PDF
          </a>
        </div>

        <div className="legal-doc-viewer" aria-label="Просмотр согласия на обработку персональных данных">
          <iframe
            title="Согласие на обработку персональных данных"
            src={CONSENT_DOC_URL}
            className="legal-doc-frame"
            loading="lazy"
          />
        </div>
      </div>
    </div>
  );
};

export default ConsentPage;
