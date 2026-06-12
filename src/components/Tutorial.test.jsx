import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Tutorial } from './Tutorial';

describe('Tutorial', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<Tutorial open={false} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens on the first step', () => {
    render(<Tutorial open onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Master view' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });

  it('steps forward and back', () => {
    render(<Tutorial open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: 'Sound monitoring' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Master view' })).toBeInTheDocument();
  });

  it('jumps to a step via the progress dots', () => {
    render(<Tutorial open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Step 5: Library' }));
    expect(screen.getByRole('heading', { name: 'Library' })).toBeInTheDocument();
  });

  it('arrow keys navigate, Escape closes', () => {
    const onClose = vi.fn();
    render(<Tutorial open onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByRole('heading', { name: 'Sound monitoring' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByRole('heading', { name: 'Master view' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('the last step turns Next into Done, which closes', () => {
    const onClose = vi.fn();
    render(<Tutorial open onClose={onClose} />);
    for (let i = 0; i < 5; i += 1) fireEvent.click(screen.getByRole('button', { name: /Next|Done/ }));
    expect(screen.getByRole('heading', { name: 'Mixing' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('reopening resets to the first step', () => {
    const { rerender } = render(<Tutorial open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    rerender(<Tutorial open={false} onClose={vi.fn()} />);
    rerender(<Tutorial open onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Master view' })).toBeInTheDocument();
  });

  it('close button and backdrop clicks close', () => {
    const onClose = vi.fn();
    render(<Tutorial open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close tutorial' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = document.querySelector('.fixed.inset-0');
    fireEvent.pointerDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('clicks inside the dialog do not close it', () => {
    const onClose = vi.fn();
    render(<Tutorial open onClose={onClose} />);
    fireEvent.pointerDown(screen.getByRole('heading', { name: 'Master view' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
