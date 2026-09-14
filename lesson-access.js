/* Shared with agroclub-webhook: keep both deployed copies identical. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgroLessonAccess = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function orderedCourses(courses) {
    return (Array.isArray(courses) ? courses : []).filter(c => c && c.activo !== false)
      .slice().sort((a, b) => ((Number(a.orden) || 9999) - (Number(b.orden) || 9999))
        || String(a.id || '').localeCompare(String(b.id || '')));
  }
  function orderedLessons(course) {
    return (Array.isArray(course && course.clases) ? course.clases : []).slice()
      .sort((a, b) => Number(a.num) - Number(b.num));
  }
  function firstCourse(courses) { return orderedCourses(courses)[0] || null; }
  function isFreeLesson(courses, courseId, lessonNumber) {
    const first = firstCourse(courses);
    if (!first || String(first.id) !== String(courseId)) return false;
    const lessons = orderedLessons(first);
    const nums = lessons.map(l => Number(l.num));
    // A one-lesson course consists only of its paid final lesson.
    if (lessons.length < 2 || !nums.every(Number.isFinite) || new Set(nums).size !== nums.length) return false;
    const index = nums.indexOf(Number(lessonNumber));
    return index >= 0 && index < lessons.length - 1;
  }
  function canPlay({ courses, courseId, lessonNumber, hasMembership = false, isAdmin = false }) {
    const course = orderedCourses(courses).find(c => String(c.id) === String(courseId));
    if (!course || !orderedLessons(course).some(l => Number(l.num) === Number(lessonNumber))) return false;
    return isAdmin || hasMembership || isFreeLesson(courses, courseId, lessonNumber);
  }
  return { orderedCourses, orderedLessons, firstCourse, isFreeLesson, canPlay };
});
