function puedeCancelar(decoded, email, docId, miembro) {
  if (!decoded?.uid || !decoded?.email) return false;
  if (String(decoded.email).trim().toLowerCase() !== email) return false;
  const duenoPorUid = docId === decoded.uid || miembro?.uid === decoded.uid;
  return duenoPorUid || decoded.email_verified === true;
}

module.exports = { puedeCancelar };
