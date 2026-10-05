import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SensitiveAreasField, { SENSITIVE_AREAS_HINT } from './SensitiveAreasField';

describe('SensitiveAreasField', () => {
  it('renders the list, the hint, and reports edits', () => {
    const onChange = vi.fn();
    render(<SensitiveAreasField value="- the orders tables" onChange={onChange} />);

    const field = screen.getByTestId('sensitive-areas-input');
    expect(field).toHaveValue('- the orders tables');
    expect(screen.getByText(SENSITIVE_AREAS_HINT)).toBeInTheDocument();
    expect(screen.getByLabelText(/Sensitive areas/)).toBe(field);

    fireEvent.change(field, { target: { value: '- checkout' } });
    expect(onChange).toHaveBeenCalledWith('- checkout');
  });

  it('can be disabled', () => {
    render(<SensitiveAreasField value="" onChange={vi.fn()} disabled />);
    expect(screen.getByTestId('sensitive-areas-input')).toBeDisabled();
  });
});
