import React, { useId, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import type { ListedModel } from '../../shared/types/onboarding';
import {
  formatAaBenchmarks,
  formatContextLength,
  formatListedModelMeta,
  formatModelPricing,
  getModelPromptPricePerToken,
} from '../../shared/modelListingDisplay';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';

type PriceSortDirection = 'asc' | 'desc';
type AaSortDirection = 'asc' | 'desc';
type TableSortKey = 'price' | 'aa';

const AA_CITATION =
  'Source: Artificial Analysis (artificialanalysis.ai) via OpenRouter (openrouter.ai/rankings).';

interface ModelPickerProps {
  models: ListedModel[];
  selectedModelId: string;
  onSelect: (modelId: string) => void;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  label?: string;
  /** Show a type-to-filter box inside the dropdown (intended for large catalogs like OpenRouter). */
  filterable?: boolean;
  /** The model in use. When set and different from the selection, the summary says it is unsaved. */
  savedModelId?: string;
  /** Rendered inside the selected-model summary, e.g. a Save button. Filterable mode only. */
  summaryAction?: React.ReactNode;
}

/** Orders by `value` in `direction`, models without a value last, ties by name. */
function compareByValue(
  a: ListedModel,
  b: ListedModel,
  value: (model: ListedModel) => number | undefined,
  direction: 'asc' | 'desc'
): number {
  const valueA = value(a);
  const valueB = value(b);
  const byName = (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id);
  if (valueA === undefined && valueB === undefined) return byName;
  if (valueA === undefined) return 1;
  if (valueB === undefined) return -1;
  const diff = direction === 'asc' ? valueA - valueB : valueB - valueA;
  return diff !== 0 ? diff : byName;
}

function compareByPromptPrice(
  a: ListedModel,
  b: ListedModel,
  direction: PriceSortDirection
): number {
  return compareByValue(a, b, getModelPromptPricePerToken, direction);
}

function getAaIntelligence(model: ListedModel): number | undefined {
  const value = model.aa?.intelligence;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function getModelRowLabels(model: ListedModel): {
  displayName: string;
  showId: boolean;
  priceLabel: string;
  aaLabel: string;
  contextLabel: string;
} {
  return {
    displayName: model.displayName ?? model.id,
    showId: Boolean(model.displayName && model.displayName !== model.id),
    priceLabel: formatModelPricing(model.pricing) ?? '—',
    aaLabel: formatAaBenchmarks(model.aa) ?? '—',
    contextLabel: formatContextLength(model.contextLength) ?? '—',
  };
}

function SelectedModelSummary({
  model,
  selectedModelId,
  showAaColumn,
  savedModelId,
  action,
}: {
  model: ListedModel | undefined;
  selectedModelId: string;
  showAaColumn: boolean;
  savedModelId?: string;
  action?: React.ReactNode;
}) {
  if (!selectedModelId) {
    return (
      <div
        role="status"
        aria-label="Selected model"
        className="rounded-md border border-dashed border-line bg-surface-0 px-3 py-3"
      >
        <p className="text-2xs font-medium uppercase tracking-wide text-fg-faint">
          Selected model
        </p>
        <p className="mt-1 text-ui text-fg-faint">Choose a model from the list below.</p>
      </div>
    );
  }

  const displayName = model?.displayName ?? model?.id ?? selectedModelId;
  const showId = Boolean(model?.displayName && model.displayName !== model.id);
  const priceLabel = model ? (formatModelPricing(model.pricing) ?? '—') : '—';
  const aaLabel = model ? (formatAaBenchmarks(model.aa) ?? '—') : '—';
  const contextLabel = model ? (formatContextLength(model.contextLength) ?? '—') : '—';
  const unsaved = savedModelId !== undefined && savedModelId !== selectedModelId;

  return (
    <div
      role="status"
      aria-label="Selected model"
      className="rounded-md border border-brand/40 bg-brand-dim px-3 py-3"
    >
      <div className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-brand">
        {!unsaved && <Check className="h-3.5 w-3.5" aria-hidden />}
        {unsaved ? 'New selection · not saved' : 'Selected model'}
      </div>
      <div className="mt-1.5 min-w-0">
        <div className="break-words text-title font-medium text-fg">{displayName}</div>
        {showId && (
          <div className="break-all font-mono text-xs text-fg-muted">{model?.id}</div>
        )}
      </div>
      <dl
        className={`mt-2 grid gap-x-4 gap-y-1 text-ui text-fg-muted ${
          showAaColumn ? 'grid-cols-3' : 'grid-cols-2'
        }`}
      >
        <div className="min-w-0">
          <dt className="text-2xs font-medium uppercase tracking-wide text-brand">
            Price
          </dt>
          <dd className="truncate">{priceLabel}</dd>
        </div>
        {showAaColumn && (
          <div className="min-w-0">
            <dt className="text-2xs font-medium uppercase tracking-wide text-brand">
              AA
            </dt>
            <dd className="truncate">{aaLabel}</dd>
          </div>
        )}
        <div className="min-w-0">
          <dt className="text-2xs font-medium uppercase tracking-wide text-brand">
            Context
          </dt>
          <dd className="truncate">{contextLabel}</dd>
        </div>
      </dl>
      {model?.description && (
        <p className="mt-2 text-ui text-fg-muted">{model.description}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

function compareByAaIntelligence(
  a: ListedModel,
  b: ListedModel,
  direction: AaSortDirection
): number {
  return compareByValue(a, b, getAaIntelligence, direction);
}

export const ModelPicker: React.FC<ModelPickerProps> = ({
  models,
  selectedModelId,
  onSelect,
  loading = false,
  error = null,
  onRefresh,
  label = 'Model',
  filterable: filterableProp,
  savedModelId,
  summaryAction,
}) => {
  // Settings can show two pickers at once (Local and OpenRouter); each label needs its own id.
  const controlId = useId();
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  const [sortKey, setSortKey] = useState<TableSortKey>('price');
  const [priceSort, setPriceSort] = useState<PriceSortDirection>('asc');
  const [aaSort, setAaSort] = useState<AaSortDirection>('desc');
  const filterable = filterableProp ?? models.length >= 12;
  const showAaColumn = models.some((model) => Boolean(model.aa));
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const selectedLabel = selectedModel?.displayName ?? selectedModel?.id;
  const emptyColSpan = showAaColumn ? 4 : 3;

  const visibleModels = useMemo(() => {
    const query = filterable ? filter.trim().toLowerCase() : '';
    const filtered = !query
      ? models
      : models.filter((model) => {
          const name = (model.displayName ?? model.id).toLowerCase();
          return name.includes(query) || model.id.toLowerCase().includes(query);
        });

    if (!filterable) {
      return filtered;
    }

    if (sortKey === 'aa' && showAaColumn) {
      return [...filtered].sort((a, b) => compareByAaIntelligence(a, b, aaSort));
    }

    return [...filtered].sort((a, b) => compareByPromptPrice(a, b, priceSort));
  }, [aaSort, filter, filterable, models, priceSort, showAaColumn, sortKey]);

  const isDisabled = loading || models.length === 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={controlId} className="text-fg">
          {label}
        </Label>
        {onRefresh && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={onRefresh}
            
          >
            {loading ? 'Refreshing...' : 'Refresh models'}
          </Button>
        )}
      </div>

      {filterable ? (
        <div className="space-y-2">
          <SelectedModelSummary
            model={selectedModel}
            selectedModelId={selectedModelId}
            showAaColumn={showAaColumn}
            savedModelId={savedModelId}
            action={summaryAction}
          />
          <div
            className={`overflow-hidden rounded-md border border-line bg-surface-0 ${
              isDisabled ? 'pointer-events-none opacity-60' : ''
            }`}
          >
            <div className="border-b border-line p-2">
              <Input
                id={controlId}
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                }}
                disabled={isDisabled}
                placeholder="Filter models..."
                
              />
            </div>
            <div className="max-h-72 overflow-y-auto">
            <table className="w-full table-fixed text-left text-ui text-fg">
              <thead className="sticky top-0 z-10 bg-surface-1">
                <tr className="border-b border-line text-xs uppercase tracking-wide text-fg-faint">
                  <th className={`${showAaColumn ? 'w-[38%]' : 'w-[50%]'} px-3 py-2 font-medium`}>
                    Model
                  </th>
                  <th className={`${showAaColumn ? 'w-[22%]' : 'w-[30%]'} px-3 py-2 font-medium`}>
                    <button
                      type="button"
                      className="inline-flex flex-col items-start gap-0.5 text-left hover:text-fg"
                      onClick={() => {
                        if (sortKey === 'price') {
                          setPriceSort((current) => (current === 'asc' ? 'desc' : 'asc'));
                        } else {
                          setSortKey('price');
                        }
                      }}
                      title="USD per million tokens. Left is input (prompt); right is output (completion). Sorted by input price."
                      aria-label={
                        priceSort === 'asc'
                          ? 'Sort by input price: cheapest first. Values are input / output USD per million tokens.'
                          : 'Sort by input price: most expensive first. Values are input / output USD per million tokens.'
                      }
                    >
                      <span className="inline-flex items-center gap-1">
                        Price
                        {sortKey === 'price' ? (
                          priceSort === 'asc' ? (
                            <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                          )
                        ) : null}
                      </span>
                      <span className="normal-case tracking-normal text-2xs font-normal text-fg-faint">
                        in / out · $/M
                      </span>
                    </button>
                  </th>
                  {showAaColumn && (
                    <th className="w-[24%] px-3 py-2 font-medium">
                      <button
                        type="button"
                        className="inline-flex flex-col items-start gap-0.5 text-left hover:text-fg"
                        onClick={() => {
                          if (sortKey === 'aa') {
                            setAaSort((current) => (current === 'asc' ? 'desc' : 'asc'));
                          } else {
                            setSortKey('aa');
                          }
                        }}
                        title={AA_CITATION}
                        aria-label={
                          aaSort === 'desc'
                            ? 'Sort by Artificial Analysis intelligence: highest first.'
                            : 'Sort by Artificial Analysis intelligence: lowest first.'
                        }
                      >
                        <span className="inline-flex items-center gap-1">
                          AA
                          {sortKey === 'aa' ? (
                            aaSort === 'desc' ? (
                              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                            ) : (
                              <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                            )
                          ) : null}
                        </span>
                        <span className="normal-case tracking-normal text-2xs font-normal text-fg-faint">
                          Int · Code
                        </span>
                      </button>
                    </th>
                  )}
                  <th className={`${showAaColumn ? 'w-[16%]' : 'w-[20%]'} px-3 py-2 font-medium`}>
                    Context
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleModels.length === 0 ? (
                  <tr>
                    <td colSpan={emptyColSpan} className="px-3 py-4 text-ui text-fg-faint">
                      {models.length === 0 ? 'No models available' : 'No models match'}
                    </td>
                  </tr>
                ) : (
                  visibleModels.map((model) => {
                    const { displayName, showId, priceLabel, aaLabel, contextLabel } =
                      getModelRowLabels(model);
                    const isSelected = model.id === selectedModelId;

                    return (
                      <tr
                        key={model.id}
                        role="button"
                        tabIndex={isDisabled ? -1 : 0}
                        aria-selected={isSelected}
                        className={`cursor-pointer border-b border-line/60 outline-none last:border-b-0 transition-colors duration-(--dur-fast) hover:bg-surface-hover focus-visible:bg-surface-hover ${
                          isSelected ? 'bg-brand-dim' : ''
                        }`}
                        onClick={() => {
                          if (!isDisabled) onSelect(model.id);
                        }}
                        onKeyDown={(event) => {
                          if (isDisabled) return;
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onSelect(model.id);
                          }
                        }}
                      >
                        <td className="px-3 py-2 align-top">
                          <div className="flex min-w-0 items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="break-words font-medium">{displayName}</div>
                              {showId && (
                                <div className="break-all text-xs text-fg-faint">{model.id}</div>
                              )}
                            </div>
                            {isSelected && (
                              <span className="shrink-0 rounded bg-brand-dim px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-fg-muted">
                                Selected
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top text-fg-muted">{priceLabel}</td>
                        {showAaColumn && (
                          <td className="px-3 py-2 align-top text-fg-muted">{aaLabel}</td>
                        )}
                        <td className="px-3 py-2 align-top text-fg-muted">{contextLabel}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      ) : (
        <Select
          open={open}
          onOpenChange={setOpen}
          value={selectedModelId || undefined}
          onValueChange={onSelect}
          disabled={isDisabled}
        >
          <SelectTrigger
            id={controlId}
            className="w-full"
          >
            <SelectValue
              placeholder={models.length === 0 ? 'No models available' : 'Select a model'}
            >
              {selectedLabel}
            </SelectValue>
          </SelectTrigger>
          <SelectContent >
            {visibleModels.length === 0 ? (
              <div className="px-2 py-3 text-ui text-fg-faint">No models match</div>
            ) : (
              visibleModels.map((model) => {
                const meta = formatListedModelMeta(model);
                return (
                  <SelectItem
                    key={model.id}
                    value={model.id}
                    className="items-start py-2"
                    textValue={model.displayName ?? model.id}
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate" title={model.displayName ?? model.id}>
                        {model.displayName ?? model.id}
                      </span>
                      {meta && <span className="text-xs text-fg-faint">{meta}</span>}
                    </div>
                  </SelectItem>
                );
              })
            )}
          </SelectContent>
        </Select>
      )}

      {!filterable && selectedModel?.description && (
        <p className="text-ui text-fg-faint">{selectedModel.description}</p>
      )}
      {error && (
        <div className="rounded-md border border-danger-line bg-danger-dim px-3 py-2.5 text-ui text-danger">
          {error}
        </div>
      )}
    </div>
  );
};
