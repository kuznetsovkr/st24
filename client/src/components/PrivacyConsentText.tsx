import { Link } from 'react-router-dom';

type PrivacyConsentTextProps = {
  openInNewTab?: boolean;
};

const PrivacyConsentText = ({ openInNewTab = false }: PrivacyConsentTextProps) => {
  const linkProps = openInNewTab ? { target: '_blank', rel: 'noopener noreferrer' } : {};

  return (
    <span className="legal-consent-text">
      <span className="legal-consent-main">
        Согласен с <Link to="/terms" {...linkProps}>условиями оферты</Link>,{' '}
        <Link to="/privacy" {...linkProps}>политикой обработки персональных данных</Link> и{' '}
        <Link to="/consent" {...linkProps}>согласием на обработку персональных данных</Link>.
      </span>
      <span className="legal-consent-note">
        Уведомлен о передаче данных платежным, логистическим и защитным сервисам (ЮKassa, СДЭК, Деловые Линии,
        Почта России, Cloudflare Turnstile, SMS.ru, Telegram Gateway) и о возможной трансграничной передаче
        технических данных в случаях, указанных в политике.
      </span>
    </span>
  );
};

export default PrivacyConsentText;
