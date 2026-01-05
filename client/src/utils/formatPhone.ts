export const formatPhone = (value: string) => {
  const digits = value.replace(/\D/g, '');
  if (!digits) {
    return '';
  }

  let normalized = digits;
  if (normalized.startsWith('8')) {
    normalized = `7${normalized.slice(1)}`;
  }
  if (normalized.startsWith('7')) {
    normalized = normalized.slice(1);
  }
  normalized = normalized.slice(0, 10);

  let result = '+7';
  if (!normalized) {
    return result;
  }

  const area = normalized.slice(0, 3);
  const middle = normalized.slice(3, 6);
  const part1 = normalized.slice(6, 8);
  const part2 = normalized.slice(8, 10);

  if (area) {
    result += ` (${area}`;
    if (area.length === 3 && normalized.length > 3) {
      result += ')';
    }
  }
  if (middle) {
    result += ` ${middle}`;
  }
  if (part1) {
    result += `-${part1}`;
  }
  if (part2) {
    result += `-${part2}`;
  }

  return result;
};
