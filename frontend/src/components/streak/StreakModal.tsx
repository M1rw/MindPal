import React from 'react';
import { useStreakStore } from '../../store';
import { Modal, ModalBody, ModalHeader } from '../ui/Modal';
import {
  WEEKDAY_LABELS,
  dayAriaLabel,
  mondayIndex,
  streakHeadline,
  streakSourceNote,
  streakSupport,
} from '../../utils/streak/streak';

export const StreakModal: React.FC = () => {
  const { streak, totalReflections, source, isOpen, setIsOpen } = useStreakStore();
  const close = () => setIsOpen(false);

  const todayIndex = mondayIndex();
  const todayDone = Boolean(streak.weeklyDays[todayIndex]);
  const weekHasAny = streak.weeklyDays.some(Boolean);
  const showCount = streak.count > 0;

  return (
    <Modal
      id="streak-modal"
      panelId="streak-content"
      open={isOpen}
      onClose={close}
      labelledBy="streak-modal-title"
      size="sm"
      layer={70}
    >
      <ModalHeader
        kicker="Days"
        title="Showing up"
        titleId="streak-modal-title"
        onClose={close}
        closeLabel="Close progress view"
      />
      <ModalBody className="flex flex-col gap-6">
        <div className="text-center">
          {showCount ? (
            <>
              <p className="text-5xl font-semibold tracking-tight tabular-nums text-content-primary">
                {streak.count}
              </p>
              <p className="mt-1 text-sm font-medium text-content-secondary">{streakHeadline(streak.count)}</p>
            </>
          ) : (
            <p className="text-lg font-semibold tracking-tight text-content-primary">Start a run of days</p>
          )}
          <p className="mt-2 text-sm leading-relaxed text-content-secondary">
            {streakSupport(streak.count, todayDone, weekHasAny)}
          </p>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-content-muted text-center mb-3">
            This week
          </h3>
          <ol className="streak-week" aria-label="Days you wrote this week">
            {WEEKDAY_LABELS.map((label, index) => {
              const done = Boolean(streak.weeklyDays[index]);
              const isToday = index === todayIndex;
              return (
                <li key={`${label}-${index}`} className="streak-day" aria-label={dayAriaLabel(index, done, isToday)}>
                  <span
                    className={[
                      'streak-day__mark',
                      done ? 'streak-day__mark--done' : '',
                      isToday ? 'streak-day__mark--today' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    aria-hidden="true"
                  />
                  <span className={isToday ? 'streak-day__label streak-day__label--today' : 'streak-day__label'} aria-hidden="true">
                    {isToday ? 'Today' : label}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        {totalReflections > 0 ? (
          <p className="text-center text-sm text-content-secondary">
            {totalReflections === 1 ? '1 message sent' : `${totalReflections} messages sent`}
          </p>
        ) : null}

        <p className="text-center text-xs leading-relaxed text-content-muted">{streakSourceNote(source)}</p>
      </ModalBody>
    </Modal>
  );
};
