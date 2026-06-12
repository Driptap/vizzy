// Minimal column-major 4x4 matrix / quaternion math for the mesh deck passes
// (models, landscapes, scenes). Conventions match three.js: right-handed,
// y-up, camera looks down -z; projection uses wgpu's 0..1 depth range.

/// Column-major: m[col * 4 + row], same memory layout WGSL mat4x4 expects.
pub type Mat4 = [f32; 16];

pub const IDENTITY: Mat4 = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 1.0, 0.0, 0.0, //
    0.0, 0.0, 1.0, 0.0, //
    0.0, 0.0, 0.0, 1.0,
];

pub fn mat4_mul(a: &Mat4, b: &Mat4) -> Mat4 {
    let mut out = [0.0; 16];
    for col in 0..4 {
        for row in 0..4 {
            let mut sum = 0.0;
            for k in 0..4 {
                sum += a[k * 4 + row] * b[col * 4 + k];
            }
            out[col * 4 + row] = sum;
        }
    }
    out
}

/// Perspective projection with wgpu clip conventions (depth 0..1, -z forward).
pub fn perspective(fovy_rad: f32, aspect: f32, near: f32, far: f32) -> Mat4 {
    let f = 1.0 / (fovy_rad * 0.5).tan();
    let mut m = [0.0; 16];
    m[0] = f / aspect;
    m[5] = f;
    m[10] = far / (near - far);
    m[11] = -1.0;
    m[14] = near * far / (near - far);
    m
}

/// Rotation matrix columns from a (x, y, z, w) quaternion (assumed unit-ish;
/// normalized defensively since the values arrive over IPC as floats).
pub fn quat_to_mat3(q: [f32; 4]) -> [[f32; 3]; 3] {
    let len = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    let (x, y, z, w) = if len > 1e-12 {
        (q[0] / len, q[1] / len, q[2] / len, q[3] / len)
    } else {
        (0.0, 0.0, 0.0, 1.0)
    };
    let (x2, y2, z2) = (x + x, y + y, z + z);
    let (xx, xy, xz) = (x * x2, x * y2, x * z2);
    let (yy, yz, zz) = (y * y2, y * z2, z * z2);
    let (wx, wy, wz) = (w * x2, w * y2, w * z2);
    [
        [1.0 - (yy + zz), xy + wz, xz - wy], // column 0
        [xy - wz, 1.0 - (xx + zz), yz + wx], // column 1
        [xz + wy, yz - wx, 1.0 - (xx + yy)], // column 2
    ]
}

/// T(t) * R(q) * S(s) — the model matrix the TS client describes per frame.
pub fn compose_trs(t: [f32; 3], q: [f32; 4], s: [f32; 3]) -> Mat4 {
    let r = quat_to_mat3(q);
    let mut m = [0.0; 16];
    for col in 0..3 {
        for row in 0..3 {
            m[col * 4 + row] = r[col][row] * s[col];
        }
    }
    m[12] = t[0];
    m[13] = t[1];
    m[14] = t[2];
    m[15] = 1.0;
    m
}

/// View matrix for a camera at `pos` with orientation `q`:
/// inverse(T(pos) * R(q)) = R(q)ᵀ * T(-pos).
pub fn view_from_camera(pos: [f32; 3], q: [f32; 4]) -> Mat4 {
    let r = quat_to_mat3(q);
    let mut m = [0.0; 16];
    for col in 0..3 {
        for row in 0..3 {
            // transpose: column `col` of Rᵀ is row `col` of R
            m[col * 4 + row] = r[row][col];
        }
    }
    for row in 0..3 {
        m[12 + row] = -(r[0][row] * pos[0] + r[1][row] * pos[1] + r[2][row] * pos[2]);
    }
    m[15] = 1.0;
    m
}

/// Inverse-transpose of a Mat4's upper 3x3 — the world-space normal matrix.
/// Handles non-uniform (jelly) and negative (mirrored tile) scales. A
/// degenerate matrix falls back to identity rather than NaN-ing the frame.
pub fn inverse_transpose3(m: &Mat4) -> [[f32; 3]; 3] {
    // a[col][row]; cofactor expansion, det via the first column of cofactors
    let a = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
    let c00 = a[1][1] * a[2][2] - a[2][1] * a[1][2];
    let c01 = a[2][0] * a[1][2] - a[1][0] * a[2][2];
    let c02 = a[1][0] * a[2][1] - a[2][0] * a[1][1];
    let det = a[0][0] * c00 + a[0][1] * c01 + a[0][2] * c02;
    if det.abs() < 1e-12 {
        return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    }
    let inv_det = 1.0 / det;
    // inverse(A)ᵀ = cofactor(A) / det — cofactor matrix directly, no transposes
    [
        [c00 * inv_det, c01 * inv_det, c02 * inv_det],
        [
            (a[2][1] * a[0][2] - a[0][1] * a[2][2]) * inv_det,
            (a[0][0] * a[2][2] - a[2][0] * a[0][2]) * inv_det,
            (a[2][0] * a[0][1] - a[0][0] * a[2][1]) * inv_det,
        ],
        [
            (a[0][1] * a[1][2] - a[1][1] * a[0][2]) * inv_det,
            (a[1][0] * a[0][2] - a[0][0] * a[1][2]) * inv_det,
            (a[0][0] * a[1][1] - a[1][0] * a[0][1]) * inv_det,
        ],
    ]
}

pub fn transform_point(m: &Mat4, p: [f32; 3]) -> [f32; 3] {
    [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ]
}

pub fn mul3(r: &[[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [
        r[0][0] * v[0] + r[1][0] * v[1] + r[2][0] * v[2],
        r[0][1] * v[0] + r[1][1] * v[1] + r[2][1] * v[2],
        r[0][2] * v[0] + r[1][2] * v[1] + r[2][2] * v[2],
    ]
}

pub fn normalize3(v: [f32; 3]) -> [f32; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len > 1e-12 {
        [v[0] / len, v[1] / len, v[2] / len]
    } else {
        [0.0, 0.0, 1.0]
    }
}

pub fn cross3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// (x, y, z, w) quaternion from intrinsic XYZ Euler angles — THREE's default
/// `Object3D.rotation` order, matching `Quaternion.setFromEuler('XYZ')`.
pub fn quat_from_euler_xyz(x: f32, y: f32, z: f32) -> [f32; 4] {
    let (s1, c1) = (x * 0.5).sin_cos();
    let (s2, c2) = (y * 0.5).sin_cos();
    let (s3, c3) = (z * 0.5).sin_cos();
    [
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 + s1 * s2 * c3,
        c1 * c2 * c3 - s1 * s2 * s3,
    ]
}

/// XYZ Euler angles from a pure-rotation 3x3 (columns are basis vectors;
/// r[col][row]) — THREE's `Euler.setFromRotationMatrix(m, 'XYZ')`.
pub fn euler_xyz_from_mat3(r: &[[f32; 3]; 3]) -> [f32; 3] {
    let m13 = r[2][0];
    let y = m13.clamp(-1.0, 1.0).asin();
    if m13.abs() < 0.999_999_9 {
        let x = (-r[2][1]).atan2(r[2][2]);
        let z = (-r[1][0]).atan2(r[0][0]);
        [x, y, z]
    } else {
        let x = r[1][2].atan2(r[1][1]);
        [x, y, 0.0]
    }
}

/// Orientation of an object at `eye` looking at `target` with up = +y, as
/// rotation-matrix columns — THREE's `Matrix4.lookAt` (camera convention:
/// local -z points at the target).
pub fn look_at_mat3(eye: [f32; 3], target: [f32; 3]) -> [[f32; 3]; 3] {
    let up = [0.0, 1.0, 0.0];
    let mut z = [eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]];
    if z[0] * z[0] + z[1] * z[1] + z[2] * z[2] == 0.0 {
        z[2] = 1.0;
    }
    let mut z = normalize3(z);
    let mut x = cross3(up, z);
    if x[0] * x[0] + x[1] * x[1] + x[2] * x[2] == 0.0 {
        // z parallel to up: nudge like THREE (|up.z| != 1 here, so z.z moves)
        z[2] += 0.0001;
        z = normalize3(z);
        x = cross3(up, z);
    }
    let x = normalize3(x);
    let y = cross3(z, x);
    [x, y, z]
}

/// The flight-camera orientation: lookAt (up +y), then the SKW roll ADDED to
/// the XYZ euler z — exactly `camera.lookAt(...); camera.rotation.z += roll`.
pub fn look_at_quat_with_roll(eye: [f32; 3], target: [f32; 3], roll: f32) -> [f32; 4] {
    let e = euler_xyz_from_mat3(&look_at_mat3(eye, target));
    quat_from_euler_xyz(e[0], e[1], e[2] + roll)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }
    fn close3(a: [f32; 3], b: [f32; 3]) -> bool {
        close(a[0], b[0]) && close(a[1], b[1]) && close(a[2], b[2])
    }

    #[test]
    fn perspective_maps_near_far_to_unit_depth() {
        let p = perspective(45f32.to_radians(), 16.0 / 9.0, 0.1, 100.0);
        // clip = P * (0, 0, z, 1); depth = clip.z / clip.w
        let depth = |z: f32| {
            let cz = p[10] * z + p[14];
            let cw = p[11] * z;
            cz / cw
        };
        assert!(close(depth(-0.1), 0.0));
        assert!(close(depth(-100.0), 1.0));
    }

    #[test]
    fn compose_trs_rotates_scales_and_translates() {
        // 90° about +z: (x=0, y=0, z=sin45, w=cos45)
        let s = std::f32::consts::FRAC_1_SQRT_2;
        let m = compose_trs([10.0, 0.0, 0.0], [0.0, 0.0, s, s], [2.0, 1.0, 1.0]);
        // (1,0,0) scaled to (2,0,0), rotated to (0,2,0), translated to (10,2,0)
        assert!(close3(
            transform_point(&m, [1.0, 0.0, 0.0]),
            [10.0, 2.0, 0.0]
        ));
    }

    #[test]
    fn view_from_camera_inverts_the_camera_pose() {
        // Camera at (0,0,4) looking down -z (identity quat): the origin lands
        // 4 units in front of the camera.
        let v = view_from_camera([0.0, 0.0, 4.0], [0.0, 0.0, 0.0, 1.0]);
        assert!(close3(
            transform_point(&v, [0.0, 0.0, 0.0]),
            [0.0, 0.0, -4.0]
        ));
        // With a 90° yaw the camera's -z axis points down world -x.
        let s = std::f32::consts::FRAC_1_SQRT_2;
        let v = view_from_camera([0.0, 0.0, 0.0], [0.0, s, 0.0, s]);
        assert!(close3(
            transform_point(&v, [-1.0, 0.0, 0.0]),
            [0.0, 0.0, -1.0]
        ));
    }

    fn close4(a: [f32; 4], b: [f32; 4]) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-5)
    }

    #[test]
    fn look_at_from_plus_z_is_identity_and_roll_is_local_z() {
        // Camera at +z looking at the origin: identity-ish orientation.
        let q = look_at_quat_with_roll([0.0, 0.0, 5.0], [0.0, 0.0, 0.0], 0.0);
        assert!(close4(q, [0.0, 0.0, 0.0, 1.0]));
        // Roll changes ONLY the local z component.
        let roll = 0.7f32;
        let q = look_at_quat_with_roll([0.0, 0.0, 5.0], [0.0, 0.0, 0.0], roll);
        assert!(close4(
            q,
            [0.0, 0.0, (roll / 2.0).sin(), (roll / 2.0).cos()]
        ));
    }

    #[test]
    fn look_at_orients_minus_z_toward_the_target() {
        // The flight camera: above the ground, looking down-forward.
        let eye = [0.0, 2.0, 4.05];
        let target = [0.0, 0.5, -6.0];
        let r = look_at_mat3(eye, target);
        // column 2 is local +z = normalize(eye - target)
        let fwd = normalize3([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
        assert!(close3(r[2], [-fwd[0], -fwd[1], -fwd[2]]));
        // round-trips through XYZ euler
        let e = euler_xyz_from_mat3(&r);
        let q = quat_from_euler_xyz(e[0], e[1], e[2]);
        let r2 = quat_to_mat3(q);
        for c in 0..3 {
            assert!(close3(r[c], r2[c]));
        }
        // degenerate eye == target does not NaN
        let q = look_at_quat_with_roll([1.0, 1.0, 1.0], [1.0, 1.0, 1.0], 0.0);
        assert!(q.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn quat_from_euler_matches_single_axis_rotations() {
        let h = 0.6f32 / 2.0;
        assert!(close4(
            quat_from_euler_xyz(0.6, 0.0, 0.0),
            [h.sin(), 0.0, 0.0, h.cos()]
        ));
        assert!(close4(
            quat_from_euler_xyz(0.0, 0.6, 0.0),
            [0.0, h.sin(), 0.0, h.cos()]
        ));
        assert!(close4(
            quat_from_euler_xyz(0.0, 0.0, 0.6),
            [0.0, 0.0, h.sin(), h.cos()]
        ));
    }

    #[test]
    fn inverse_transpose_handles_nonuniform_and_mirrored_scale() {
        let m = compose_trs([0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0], [2.0, 1.0, -2.0]);
        let n = inverse_transpose3(&m);
        // normals divide by the scale: (1,0,0) -> (0.5,0,0), z mirror flips
        assert!(close3(mul3(&n, [1.0, 0.0, 0.0]), [0.5, 0.0, 0.0]));
        assert!(close3(mul3(&n, [0.0, 0.0, 1.0]), [0.0, 0.0, -0.5]));
        // degenerate matrices fall back to identity
        let z = [0.0; 16];
        assert!(close3(
            mul3(&inverse_transpose3(&z), [0.0, 1.0, 0.0]),
            [0.0, 1.0, 0.0]
        ));
    }
}
