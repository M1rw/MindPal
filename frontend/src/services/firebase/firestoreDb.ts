/**
 * Firestore Database Service
 * Provides a lazy-initialized Firestore instance for saving user feedback,
 * chat reactions, and other user-generated data to Firebase Firestore.
 */

import { getFirestore, type Firestore } from 'firebase/firestore';
import { getFirebaseApp } from './index';

let _db: Firestore | null = null;

export function getFirestoreDb(): Firestore | null {
  const app = getFirebaseApp();
  if (!app) return null;
  if (!_db) {
    _db = getFirestore(app);
  }
  return _db;
}
