type QuantityStepIconProps = {
  type: 'plus' | 'minus';
};

const QuantityStepIcon = ({ type }: QuantityStepIconProps) => {
  if (type === 'plus') {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M6 1V11M11 6H1"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="2"
      viewBox="0 0 12 2"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M11 1H1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default QuantityStepIcon;
