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
        <Link to="/consent" {...linkProps}>согласием на обработку персональных данных</Link>, включая передачу данных
        третьим лицам в объеме, необходимом для оплаты, доставки и защиты сайта.
      </span>
    </span>
  );
};

export default PrivacyConsentText;
