const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  next();
});

// Database simulasi
let paymentSessions = {};
let paymentStats = {
  total: 0,
  success: 0,
  expired: 0,
  pending: 0,
  totalAmount: 0
};

// Cleanup expired sessions setiap 30 detik
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  Object.keys(paymentSessions).forEach(key => {
    const session = paymentSessions[key];
    if (session.status === 'active' && now > session.expiresAt) {
      session.status = 'expired';
      paymentStats.expired++;
      paymentStats.pending--;
      cleaned++;
    }
  });
  
  if (cleaned > 0) {
    console.log(`[CLEANUP] ${cleaned} session(s) expired`);
  }
}, 30000);

// Fungsi untuk generate QRIS dinamis dengan nominal
function generateQRIS(amount) {
  // Base QRIS dari Maulana Store
  const baseQRIS = "00020101021126570011ID.DANA.WWW011893600915353041430702095304143070303UMI51440014ID.CO.QRIS.WWW0215ID10232989429970303UMI5204581353033605802ID5913Maulana store6015Kota Tangerang 610515419630467D6";
  
  // Jika ada nominal, inject ke QRIS string
  if (amount > 0) {
    // Format: 54[length][amount] - sesuai standar QRIS
    const amountStr = amount.toString();
    const amountLength = amountStr.length.toString().padStart(2, '0');
    const amountField = `54${amountLength}${amountStr}`;
    
    // Insert amount field sebelum field 58 (country code)
    const qrisWithAmount = baseQRIS.replace('5802ID', `${amountField}5802ID`);
    return qrisWithAmount;
  }
  
  return baseQRIS;
}

// ============================================
// API ENDPOINTS
// ============================================

/**
 * POST /api/payment/create
 * Membuat session pembayaran baru dengan nominal
 */
app.post('/api/payment/create', (req, res) => {
  try {
    const { amount } = req.body;
    
    // Validasi nominal
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Nominal pembayaran harus lebih dari 0'
      });
    }
    
    if (amount > 10000000) {
      return res.status(400).json({
        success: false,
        error: 'Nominal maksimal Rp 10.000.000'
      });
    }
    
    const sessionId = `PAY-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = Date.now() + (60 * 1000); // 1 menit
    
    // Generate QRIS dengan nominal
    const qrisCode = generateQRIS(amount);
    
    const session = {
      id: sessionId,
      qrisCode: qrisCode,
      status: 'active',
      amount: amount,
      merchantName: 'Maulana Store',
      merchantLocation: 'Kota Tangerang',
      createdAt: Date.now(),
      expiresAt: expiresAt,
      expiresIn: 60
    };
    
    paymentSessions[sessionId] = session;
    paymentStats.total++;
    paymentStats.pending++;
    
    console.log(`[CREATE] Session: ${sessionId} | Amount: Rp ${amount.toLocaleString('id-ID')}`);
    
    res.status(201).json({
      success: true,
      data: session
    });
  } catch (error) {
    console.error('[ERROR] Create payment:', error);
    res.status(500).json({
      success: false,
      error: 'Gagal membuat session pembayaran'
    });
  }
});

/**
 * GET /api/payment/:sessionId
 * Mendapatkan detail session pembayaran
 */
app.get('/api/payment/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = paymentSessions[sessionId];
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session tidak ditemukan'
      });
    }
    
    // Auto-update status jika expired
    if (Date.now() > session.expiresAt && session.status === 'active') {
      session.status = 'expired';
      paymentStats.expired++;
      paymentStats.pending--;
      console.log(`[EXPIRED] Session: ${sessionId}`);
    }
    
    // Hitung sisa waktu
    const timeLeft = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
    
    res.json({
      success: true,
      data: {
        ...session,
        timeLeft
      }
    });
  } catch (error) {
    console.error('[ERROR] Get payment:', error);
    res.status(500).json({
      success: false,
      error: 'Terjadi kesalahan server'
    });
  }
});

/**
 * POST /api/payment/:sessionId/confirm
 * Konfirmasi pembayaran telah diterima (webhook dari payment gateway)
 */
app.post('/api/payment/:sessionId/confirm', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = paymentSessions[sessionId];
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session tidak ditemukan'
      });
    }
    
    // Validasi: Cek apakah sudah expired
    if (Date.now() > session.expiresAt) {
      session.status = 'expired';
      if (paymentStats.pending > 0) {
        paymentStats.expired++;
        paymentStats.pending--;
      }
      
      console.log(`[PAYMENT FAILED] Session expired: ${sessionId}`);
      
      return res.status(400).json({
        success: false,
        error: 'Waktu pembayaran telah habis',
        status: 'expired'
      });
    }
    
    // Validasi: Cek status session
    if (session.status !== 'active') {
      return res.status(400).json({
        success: false,
        error: `Session tidak valid (status: ${session.status})`,
        status: session.status
      });
    }
    
    // Proses pembayaran berhasil
    session.status = 'paid';
    session.paidAt = Date.now();
    session.paymentMethod = 'QRIS-DANA';
    
    paymentStats.success++;
    paymentStats.pending--;
    paymentStats.totalAmount += session.amount;
    
    console.log(`[SUCCESS] Payment: ${sessionId} | Amount: Rp ${session.amount.toLocaleString('id-ID')}`);
    
    res.json({
      success: true,
      message: 'Pembayaran berhasil diproses',
      data: session
    });
    
  } catch (error) {
    console.error('[ERROR] Confirm payment:', error);
    res.status(500).json({
      success: false,
      error: 'Gagal memproses pembayaran'
    });
  }
});

/**
 * DELETE /api/payment/:sessionId
 * Cancel session pembayaran
 */
app.delete('/api/payment/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = paymentSessions[sessionId];
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session tidak ditemukan'
      });
    }
    
    if (session.status === 'paid') {
      return res.status(400).json({
        success: false,
        error: 'Tidak dapat membatalkan pembayaran yang sudah berhasil'
      });
    }
    
    session.status = 'cancelled';
    session.cancelledAt = Date.now();
    
    if (paymentStats.pending > 0) {
      paymentStats.pending--;
    }
    
    console.log(`[CANCELLED] Session: ${sessionId}`);
    
    res.json({
      success: true,
      message: 'Session pembayaran dibatalkan'
    });
    
  } catch (error) {
    console.error('[ERROR] Cancel payment:', error);
    res.status(500).json({
      success: false,
      error: 'Gagal membatalkan pembayaran'
    });
  }
});

/**
 * GET /api/stats
 * Mendapatkan statistik pembayaran
 */
app.get('/api/stats', (req, res) => {
  try {
    const activeSessions = Object.values(paymentSessions).filter(s => s.status === 'active').length;
    
    res.json({
      success: true,
      data: {
        ...paymentStats,
        activeSessions,
        totalSessions: Object.keys(paymentSessions).length
      }
    });
  } catch (error) {
    console.error('[ERROR] Get stats:', error);
    res.status(500).json({
      success: false,
      error: 'Gagal mendapatkan statistik'
    });
  }
});

/**
 * GET /api/health
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint tidak ditemukan'
  });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({
    success: false,
    error: 'Terjadi kesalahan server'
  });
});

// Start server
app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('🚀 QRIS Payment Server - Maulana Store');
  console.log('='.repeat(50));
  console.log(`📍 Server running on: http://localhost:${PORT}`);
  console.log(`⏰ Started at: ${new Date().toISOString()}`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('='.repeat(50));
  console.log('\n✅ Available endpoints:');
  console.log('  POST   /api/payment/create         - Buat transaksi baru');
  console.log('  GET    /api/payment/:sessionId     - Cek status transaksi');
  console.log('  POST   /api/payment/:sessionId/confirm - Konfirmasi pembayaran');
  console.log('  DELETE /api/payment/:sessionId     - Cancel transaksi');
  console.log('  GET    /api/stats                  - Statistik pembayaran');
  console.log('  GET    /api/health                 - Server health check');
  console.log('\n💡 Press Ctrl+C to stop\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n⚠️  SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down gracefully...');
  console.log('📊 Final stats:', paymentStats);
  console.log(`💰 Total revenue: Rp ${paymentStats.totalAmount.toLocaleString('id-ID')}`);
  process.exit(0);
});
