import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ContextUsageMeter, ContextUsageRing } from './ContextUsageRing'

describe('ContextUsageRing', () => {
  it('draws the used fraction and leaves the ring empty when usage is unknown', () => {
    const { container, rerender } = render(<ContextUsageRing percent={25} />)
    expect(container.querySelector('.codex-context-value')).toHaveAttribute('stroke-dashoffset', '75')
    rerender(<ContextUsageRing percent={null} />)
    expect(container.querySelector('.codex-context-value')).toHaveAttribute('stroke-dashoffset', '100')
  })
})

describe('ContextUsageMeter', () => {
  it('exposes the percent to assistive technology and omits aria-valuenow when unknown', () => {
    const { rerender } = render(<ContextUsageMeter id="meter" label="Context usage" percent={42.5} text="42.5% used" />)
    const meter = screen.getByRole('progressbar', { name: 'Context usage' })
    expect(meter).toHaveAttribute('id', 'meter')
    expect(meter).toHaveAttribute('aria-valuenow', '42.5')
    expect(meter).toHaveAttribute('aria-valuetext', '42.5% used')
    rerender(<ContextUsageMeter id="meter" label="Context usage" percent={null} text="Unavailable" />)
    expect(meter).not.toHaveAttribute('aria-valuenow')
    expect(meter).toHaveTextContent('Unavailable')
  })
})
