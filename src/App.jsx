import { useEffect, useMemo, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { auth, db, googleProvider } from './firebase';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayKey = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};
const fromKey = (key) => new Date(`${key}T12:00:00`);
const addDays = (date, amount) => {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + amount);
  return copy;
};
const isScheduled = (task, date) => {
  if (task.recurrence === 'once') return task.dueDate === dayKey(date);
  return (task.days || []).includes(date.getDay());
};
const completedToday = (task, date = new Date()) => (task.completedDates || []).includes(dayKey(date));

function calculateStreak(task, today = new Date()) {
  const completed = new Set(task.completedDates || []);
  let cursor = new Date(today);
  if (!isScheduled(task, cursor) || !completed.has(dayKey(cursor))) cursor = addDays(cursor, -1);
  let streak = 0;
  let safety = 0;
  while (safety < 3700) {
    if (isScheduled(task, cursor)) {
      if (!completed.has(dayKey(cursor))) break;
      streak += 1;
    }
    cursor = addDays(cursor, -1);
    safety += 1;
    if (task.recurrence === 'once') break;
  }
  return streak;
}

function recurrenceLabel(task) {
  if (task.recurrence === 'once') return `One time · ${task.dueDate}`;
  if ((task.days || []).length === 7) return 'Every day';
  return (task.days || []).map((d) => DAYS[d]).join(', ');
}

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState('');
  const [recurrence, setRecurrence] = useState('weekly');
  const [days, setDays] = useState([new Date().getDay()]);
  const [dueDate, setDueDate] = useState(dayKey());
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => onAuthStateChanged(auth, (nextUser) => {
    setUser(nextUser);
    setLoading(false);
  }), []);

  useEffect(() => {
    if (!user) {
      setTasks([]);
      return undefined;
    }
    const tasksCollection = collection(db, 'users', user.uid, 'tasks');
    return onSnapshot(tasksCollection, (snapshot) => {
      const loadedTasks = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      loadedTasks.sort((a, b) => {
        if (typeof a.order === 'number' && typeof b.order === 'number') return a.order - b.order;
        if (typeof a.order === 'number') return -1;
        if (typeof b.order === 'number') return 1;
        return (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0);
      });
      setTasks(loadedTasks);
    }, (err) => setError(err.message));
  }, [user]);

  const todaysTasks = useMemo(() => tasks.filter((task) => isScheduled(task, new Date())), [tasks]);
  const doneCount = todaysTasks.filter((task) => completedToday(task)).length;

  async function login() {
    setError('');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setError(err.message);
    }
  }

  function resetForm() {
    setTitle('');
    setRecurrence('weekly');
    setDays([new Date().getDay()]);
    setDueDate(dayKey());
    setEditingId(null);
  }

  async function saveTask(event) {
    event.preventDefault();
    if (!title.trim() || !user) return;
    if (recurrence === 'weekly' && days.length === 0) {
      setError('Choose at least one recurring day.');
      return;
    }
    const payload = {
      title: title.trim(),
      recurrence,
      days: recurrence === 'weekly' ? [...days].sort() : [],
      dueDate: recurrence === 'once' ? dueDate : null,
      updatedAt: serverTimestamp(),
    };
    try {
      if (editingId) await updateDoc(doc(db, 'users', user.uid, 'tasks', editingId), payload);
      else await addDoc(collection(db, 'users', user.uid, 'tasks'), {
        ...payload,
        completedDates: [],
        order: tasks.length,
        createdAt: serverTimestamp(),
      });
      resetForm();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleTask(task) {
    const today = dayKey();
    const existing = task.completedDates || [];
    const completedDates = existing.includes(today)
      ? existing.filter((date) => date !== today)
      : [...existing, today];
    await updateDoc(doc(db, 'users', user.uid, 'tasks', task.id), { completedDates, updatedAt: serverTimestamp() });
  }

  function beginEdit(task) {
    setEditingId(task.id);
    setTitle(task.title);
    setRecurrence(task.recurrence);
    setDays(task.days || []);
    setDueDate(task.dueDate || dayKey());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function removeTask(task) {
    if (confirm(`Delete “${task.title}”?`)) await deleteDoc(doc(db, 'users', user.uid, 'tasks', task.id));
  }

  async function moveTask(taskId, direction) {
    const currentIndex = tasks.findIndex((task) => task.id === taskId);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= tasks.length) return;

    const reordered = [...tasks];
    [reordered[currentIndex], reordered[nextIndex]] = [reordered[nextIndex], reordered[currentIndex]];
    setTasks(reordered);

    try {
      const batch = writeBatch(db);
      reordered.forEach((task, index) => {
        batch.update(doc(db, 'users', user.uid, 'tasks', task.id), { order: index });
      });
      await batch.commit();
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleDay(day) {
    setDays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day]);
  }

  if (loading) return <main className="center">Loading…</main>;
  if (!user) return (
    <main className="loginPage">
      <section className="loginCard">
        <div className="logo">✓</div>
        <h1>Streak Todo</h1>
        <p>Recurring tasks, daily completion, and streak tracking on every device.</p>
        <button className="primary" onClick={login}>Continue with Google</button>
        {error && <p className="error">{error}</p>}
      </section>
    </main>
  );

  return (
    <main className="appShell">
      <header>
        <div>
          <p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <h1>Today</h1>
        </div>
        <button className="ghost" onClick={() => signOut(auth)}>Sign out</button>
      </header>

      <section className="progressCard">
        <div><strong>{doneCount}/{todaysTasks.length}</strong><span> completed today</span></div>
        <div className="progress"><div style={{ width: `${todaysTasks.length ? (doneCount / todaysTasks.length) * 100 : 0}%` }} /></div>
      </section>

      <form className="taskForm" onSubmit={saveTask}>
        <h2>{editingId ? 'Edit task' : 'Add a task'}</h2>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What do you need to do?" maxLength={100} />
        <div className="segmented">
          <button type="button" className={recurrence === 'weekly' ? 'active' : ''} onClick={() => setRecurrence('weekly')}>Recurring</button>
          <button type="button" className={recurrence === 'once' ? 'active' : ''} onClick={() => setRecurrence('once')}>One time</button>
        </div>
        {recurrence === 'weekly' ? (
          <div className="dayPicker">
            {DAYS.map((day, index) => <button type="button" key={day} className={days.includes(index) ? 'selected' : ''} onClick={() => toggleDay(index)}>{day[0]}</button>)}
          </div>
        ) : <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}
        <div className="formActions">
          {editingId && <button type="button" className="ghost" onClick={resetForm}>Cancel</button>}
          <button className="primary" type="submit">{editingId ? 'Save changes' : 'Add task'}</button>
        </div>
      </form>

      {error && <p className="error">{error}</p>}

      <section className="taskSection">
        <div className="sectionTitle"><h2>Scheduled today</h2><span>{todaysTasks.length}</span></div>
        {todaysTasks.length === 0 ? <div className="empty">Nothing scheduled today.</div> : todaysTasks.map((task) => {
          const done = completedToday(task);
          return <article className={`task ${done ? 'done' : ''}`} key={task.id}>
            <button className="check" onClick={() => toggleTask(task)} aria-label="Toggle task">{done ? '✓' : ''}</button>
            <div className="taskInfo"><h3>{task.title}</h3><p>{recurrenceLabel(task)} · 🔥 {calculateStreak(task)} streak</p></div>
            <button className="iconButton" onClick={() => beginEdit(task)}>Edit</button>
            <button className="iconButton danger" onClick={() => removeTask(task)}>Delete</button>
          </article>;
        })}
      </section>

      <section className="taskSection">
        <div className="sectionTitle"><h2>All tasks</h2><span>{tasks.length}</span></div>
        {tasks.map((task) => <article className="compactTask" key={task.id}>
          <div><strong>{task.title}</strong><small>{recurrenceLabel(task)} · Best/current: 🔥 {calculateStreak(task)}</small></div>
          <div className="taskActions">
            <button
              className="iconButton orderButton"
              onClick={() => moveTask(task.id, -1)}
              disabled={tasks.indexOf(task) === 0}
              aria-label={`Move ${task.title} up`}
            >↑</button>
            <button
              className="iconButton orderButton"
              onClick={() => moveTask(task.id, 1)}
              disabled={tasks.indexOf(task) === tasks.length - 1}
              aria-label={`Move ${task.title} down`}
            >↓</button>
            <button className="iconButton" onClick={() => beginEdit(task)}>Edit</button>
            <button className="iconButton danger" onClick={() => removeTask(task)}>Delete</button>
          </div>
        </article>)}
      </section>
    </main>
  );
}
