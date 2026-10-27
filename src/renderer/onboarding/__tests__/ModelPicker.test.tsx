import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ListedModel } from '../../../shared/types/onboarding';
import { ModelPicker } from '../ModelPicker';

const models: ListedModel[] = [
  {
    id: 'provider/expensive',
    displayName: 'Expensive Model',
    pricing: { promptPerToken: '0.00001', completionPerToken: '0.00003' },
    contextLength: 128_000,
  },
  {
    id: 'provider/cheap',
    displayName: 'Cheap Model',
    pricing: { promptPerToken: '0.0000001', completionPerToken: '0.0000002' },
    contextLength: 32_000,
  },
  {
    id: 'provider/free',
    displayName: 'Free Model',
    pricing: { promptPerToken: '0', completionPerToken: '0' },
    contextLength: 8_000,
  },
  {
    id: 'provider/unpriced',
    displayName: 'Unpriced Model',
    contextLength: 64_000,
  },
];

describe('ModelPicker', () => {
  afterEach(() => {
    cleanup();
  });

  it('labels the price column as input / output per million tokens', () => {
    render(
      <ModelPicker
        models={models}
        selectedModelId="provider/cheap"
        onSelect={vi.fn()}
        filterable
      />
    );

    expect(screen.getByText('in / out · $/M')).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: /input \/ output USD per million tokens/i,
      })
    ).toBeTruthy();
  });

  it('filters the table by name as the user types', () => {
    render(
      <ModelPicker
        models={models}
        selectedModelId="provider/cheap"
        onSelect={vi.fn()}
        filterable
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Filter models...'), {
      target: { value: 'free' },
    });

    const table = screen.getByRole('table');
    expect(within(table).getByText('Free Model')).toBeTruthy();
    expect(within(table).queryByText('Cheap Model')).toBeNull();
    expect(within(table).queryByText('Expensive Model')).toBeNull();
    expect(
      within(screen.getByRole('status', { name: 'Selected model' })).getByText('Cheap Model')
    ).toBeTruthy();
  });

  it('shows the selected model outside the scrollable table', () => {
    render(
      <ModelPicker
        models={models}
        selectedModelId="provider/cheap"
        onSelect={vi.fn()}
        filterable
      />
    );

    const selected = screen.getByRole('status', { name: 'Selected model' });
    expect(within(selected).getByText('Cheap Model')).toBeTruthy();
    expect(within(selected).getByText('provider/cheap')).toBeTruthy();
    expect(selected.closest('table')).toBeNull();
  });

  it('keeps the selected model visible when the table filter excludes it', () => {
    render(
      <ModelPicker
        models={models}
        selectedModelId="provider/expensive"
        onSelect={vi.fn()}
        filterable
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Filter models...'), {
      target: { value: 'free' },
    });

    expect(
      within(screen.getByRole('status', { name: 'Selected model' })).getByText('Expensive Model')
    ).toBeTruthy();
    expect(within(screen.getByRole('table')).queryByText('Expensive Model')).toBeNull();
  });

  it('prompts the user to choose a model when none is selected', () => {
    render(
      <ModelPicker models={models} selectedModelId="" onSelect={vi.fn()} filterable />
    );

    expect(screen.getByText('Choose a model from the list below.')).toBeTruthy();
  });

  it('sorts by prompt price ascending by default and toggles on Price click', () => {
    render(
      <ModelPicker
        models={models}
        selectedModelId="provider/cheap"
        onSelect={vi.fn()}
        filterable
      />
    );

    const rows = screen.getAllByRole('button').filter((el) => el.tagName === 'TR');
    expect(rows.map((row) => within(row).getByText(/Model$/).textContent)).toEqual([
      'Free Model',
      'Cheap Model',
      'Expensive Model',
      'Unpriced Model',
    ]);

    fireEvent.click(
      screen.getByRole('button', { name: /Sort by input price: cheapest first/i })
    );

    const resortedRows = screen.getAllByRole('button').filter((el) => el.tagName === 'TR');
    expect(resortedRows.map((row) => within(row).getByText(/Model$/).textContent)).toEqual([
      'Expensive Model',
      'Cheap Model',
      'Free Model',
      'Unpriced Model',
    ]);
  });

  it('selects a model when a row is clicked', () => {
    const onSelect = vi.fn();
    render(
      <ModelPicker
        models={models}
        selectedModelId="provider/cheap"
        onSelect={onSelect}
        filterable
      />
    );

    fireEvent.click(within(screen.getByRole('table')).getByText('Expensive Model'));
    expect(onSelect).toHaveBeenCalledWith('provider/expensive');
  });

  it('hides the AA column when no models have scores', () => {
    render(
      <ModelPicker
        models={models}
        selectedModelId="provider/cheap"
        onSelect={vi.fn()}
        filterable
      />
    );

    expect(screen.queryByText('Int · Code')).toBeNull();
  });

  it('shows the AA column with formatted scores and dashes for missing values', () => {
    const modelsWithAa: ListedModel[] = [
      {
        id: 'provider/high',
        displayName: 'High Score',
        pricing: { promptPerToken: '0.00001', completionPerToken: '0.00003' },
        contextLength: 128_000,
        aa: { intelligence: 71.2, coding: 65.8 },
      },
      {
        id: 'provider/none',
        displayName: 'No Score',
        pricing: { promptPerToken: '0.0000001', completionPerToken: '0.0000002' },
        contextLength: 32_000,
      },
    ];

    render(
      <ModelPicker
        models={modelsWithAa}
        selectedModelId="provider/high"
        onSelect={vi.fn()}
        filterable
      />
    );

    expect(screen.getByText('Int · Code')).toBeTruthy();
    expect(within(screen.getByRole('table')).getByText('Int 71 · Code 66')).toBeTruthy();
    expect(
      within(screen.getByRole('status', { name: 'Selected model' })).getByText('Int 71 · Code 66')
    ).toBeTruthy();

    const noScoreRow = screen.getByText('No Score').closest('tr');
    expect(noScoreRow).toBeTruthy();
    expect(within(noScoreRow as HTMLElement).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('sorts by AA intelligence when the AA header is clicked', () => {
    const modelsWithAa: ListedModel[] = [
      {
        id: 'provider/low',
        displayName: 'Low Score',
        pricing: { promptPerToken: '0.0000001', completionPerToken: '0.0000002' },
        aa: { intelligence: 40, coding: 30 },
      },
      {
        id: 'provider/high',
        displayName: 'High Score',
        pricing: { promptPerToken: '0.00001', completionPerToken: '0.00003' },
        aa: { intelligence: 90, coding: 80 },
      },
      {
        id: 'provider/none',
        displayName: 'No Score',
        pricing: { promptPerToken: '0.000001', completionPerToken: '0.000002' },
      },
    ];

    render(
      <ModelPicker
        models={modelsWithAa}
        selectedModelId="provider/high"
        onSelect={vi.fn()}
        filterable
      />
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: /Sort by Artificial Analysis intelligence: highest first/i,
      })
    );

    const rows = screen.getAllByRole('button').filter((el) => el.tagName === 'TR');
    expect(rows.map((row) => within(row).getByText(/Score$/).textContent)).toEqual([
      'High Score',
      'Low Score',
      'No Score',
    ]);
  });

  it('marks a selection that differs from the saved model as not saved', () => {
    const { rerender } = render(
      <ModelPicker
        models={models}
        selectedModelId="provider/cheap"
        savedModelId="provider/expensive"
        onSelect={vi.fn()}
        filterable
        summaryAction={<button type="button">Save model</button>}
      />
    );
    const summary = screen.getByRole('status', { name: 'Selected model' });
    expect(within(summary).getByText('New selection · not saved')).toBeTruthy();
    expect(within(summary).getByRole('button', { name: 'Save model' })).toBeTruthy();

    rerender(
      <ModelPicker
        models={models}
        selectedModelId="provider/cheap"
        savedModelId="provider/cheap"
        onSelect={vi.fn()}
        filterable
      />
    );
    expect(screen.queryByText('New selection · not saved')).toBeNull();
  });

  it('ties each label to its own control when two pickers share a page', () => {
    render(
      <div>
        <div data-testid="local">
          <ModelPicker
            models={[{ id: 'qwen' }]}
            selectedModelId="qwen"
            onSelect={vi.fn()}
            label="Local model"
          />
        </div>
        <div data-testid="openrouter">
          <ModelPicker
            models={[{ id: 'gpt' }]}
            selectedModelId="gpt"
            onSelect={vi.fn()}
            label="OpenRouter model"
            filterable
          />
        </div>
      </div>
    );
    const openRouter = screen.getByLabelText('OpenRouter model');
    expect(screen.getByTestId('openrouter').contains(openRouter)).toBe(true);
    expect(screen.getByTestId('local').contains(screen.getByLabelText('Local model'))).toBe(true);
  });
});
